// Canvas widgets: spectrogram (scroll/zoom/select) and evaluation timeline.
import { getFeatures } from "./dsp";
import { displaySpectrogram, DISPLAY_HOP, DISPLAY_SR, type DisplaySpec } from "./specdisplay";

// Perceptual "magma"-like colour map (dark = quiet, bright = loud).
const STOPS: [number, number, number][] = [
  [0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129], [181, 54, 122],
  [229, 80, 100], [251, 135, 97], [254, 194, 135], [252, 253, 191],
];
const LUT = new Uint8Array(256 * 3);
for (let i = 0; i < 256; i++) {
  const p = (i / 255) * (STOPS.length - 1), k = Math.min(STOPS.length - 2, Math.floor(p)), f = p - k;
  for (let c = 0; c < 3; c++) LUT[i * 3 + c] = Math.round(STOPS[k][c] + (STOPS[k + 1][c] - STOPS[k][c]) * f);
}
const FPS = DISPLAY_SR / DISPLAY_HOP; // 62.5 frames/s (same framing as the detector)
const H = 220;      // spectrogram height (CSS px)
const AX = 20;      // time-axis strip below it
const SOUND_HZ_LO = 60;
const mel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
const imel = (m: number) => 700 * (10 ** (m / 2595) - 1);
const FREQ_TICKS = [100, 250, 500, 1000, 2000, 3000, 4000, 6000, 8000];

/** Quantise values to 0..255 between two percentiles (auto contrast). */
function autoLevels(v: Float32Array, pLo: number, pHi: number): { q: Uint8Array; lo: number; hi: number } {
  const step = Math.max(1, Math.floor(v.length / 200000));
  const sample: number[] = [];
  for (let i = 0; i < v.length; i += step) sample.push(v[i]);
  sample.sort((a, b) => a - b);
  const at = (p: number) => sample.length ? sample[Math.min(sample.length - 1, Math.floor(p * sample.length))] : 0;
  const lo = at(pLo), hi = Math.max(lo + 6, at(pHi));
  const q = new Uint8Array(v.length), k = 255 / (hi - lo);
  for (let i = 0; i < v.length; i++) { const x = (v[i] - lo) * k; q[i] = x <= 0 ? 0 : x >= 255 ? 255 : x | 0; }
  return { q, lo, hi };
}

export interface Overlay { t0: number; t1: number; color: string; label?: string }
/** A marked time range drawn on the spectrogram, optionally playable/resizable. */
export interface Region {
  id: string; t0: number; t1: number; color: string; label?: string;
  editable?: boolean; playable?: boolean; deletable?: boolean;
  action?: { text: string; title: string; run: () => void };
}
export interface SpecViewState { pxPerSec: number; scrollLeft: number }
type DragMode = "select" | "scroll";
const COARSE = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
const MIN_REGION_S = 0.05;
export interface SpecBand { loHz: number; hiHz: number; binLo: number; binHi: number }
type Mode = "sound" | "detector";

// A grid's bin b covers frequency hzLo + b*hzPerBin; rows show [showLo, showHi] Hz on a mel scale.
interface Grid { data: Uint8Array; frames: number; bins: number; hzLo: number; hzPerBin: number; showLo: number; showHi: number }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  parent.appendChild(e);
  return e;
}

function fmtTime(t: number, step: number): string {
  const m = Math.floor(t / 60), s = t - m * 60;
  const ss = step < 1 ? s.toFixed(step < 0.5 ? 2 : 1) : String(Math.round(s));
  return m > 0 ? `${m}:${ss.padStart(step < 1 ? (step < 0.5 ? 5 : 4) : 2, "0")}` : `${ss} s`;
}

/** Scrollable, zoomable spectrogram. Only the visible window is rendered, so very
 *  long recordings work; when zoomed out each pixel shows the loudest frame it covers
 *  so short beeps never disappear. */
export class SpecView {
  root = document.createElement("div");
  /** A new selection was drawn (or the pending one changed). */
  onSelect: ((t0: number, t1: number) => void) | null = null;
  /** An editable region was resized (fires when the drag ends). */
  onRegionChange: ((id: string, t0: number, t1: number) => void) | null = null;
  onRegionPlay: ((id: string) => void) | null = null;
  onRegionDelete: ((id: string) => void) | null = null;
  /** Tap/click without dragging: e.g. play from there. */
  onTap: ((t: number) => void) | null = null;
  pxPerSec = 100;
  private scroll: HTMLDivElement;
  private inner: HTMLDivElement;
  private canvas = document.createElement("canvas");
  private cursor: HTMLDivElement;
  private sel: HTMLDivElement;
  private regionLayer: HTMLDivElement;
  private regions: Region[] = [];
  private dragMode: DragMode = COARSE ? "scroll" : "select";
  private dragBtns!: Record<DragMode, HTMLButtonElement>;
  private hintEl!: HTMLDivElement;
  private legend: HTMLSpanElement;
  private modeBtns: Record<Mode, HTMLButtonElement>;
  private mode: Mode = "sound";
  private pcm: Int16Array | null = null;
  private band: SpecBand | null = null;
  private duration = 0;
  private sound: Grid | null = null;
  private det: Grid | null = null;
  private cursorT: number | null = null;
  private raf = 0;
  private detRange: [number, number] = [0, 0];

  constructor(parent: HTMLElement) {
    this.root.className = "spec";
    const bar = el("div", "spec-bar", this.root);
    const seg = el("span", "seg", bar);
    const mk = (m: Mode, text: string, title: string) => {
      const b = el("button", "", seg); b.textContent = text; b.title = title;
      b.onclick = () => this.setMode(m);
      return b;
    };
    this.modeBtns = {
      sound: mk("sound", "Sound", "Normal spectrogram of the recording, 0–8 kHz"),
      detector: mk("detector", "What the detector hears", "The detector's input: only its frequency band, relative to the background noise (steady noise fades out)"),
    };
    const dm = el("span", "seg", bar);
    const mkd = (m: DragMode, text: string, title: string) => {
      const b = el("button", "", dm); b.textContent = text; b.title = title;
      b.onclick = () => { this.dragMode = m; this.updateButtons(); };
      return b;
    };
    this.dragBtns = {
      scroll: mkd("scroll", "✋ Scroll", "Dragging moves along the recording (on touch screens, long-press to select)"),
      select: mkd("select", "↔ Select", "Dragging selects a time range"),
    };
    const zoom = el("span", "seg", bar);
    const zb = (text: string, title: string, fn: () => void) => { const b = el("button", "", zoom); b.textContent = text; b.title = title; b.onclick = fn; };
    zb("−", "Zoom out", () => this.zoomAround(this.pxPerSec / 1.5));
    zb("Fit", "Show the whole recording", () => this.fit());
    zb("+", "Zoom in", () => this.zoomAround(this.pxPerSec * 1.5));
    this.legend = el("span", "spec-legend muted", bar);
    this.scroll = el("div", "spec-scroll", this.root) as HTMLDivElement;
    this.inner = el("div", "spec-inner", this.scroll) as HTMLDivElement;
    this.inner.appendChild(this.canvas);
    this.cursor = el("div", "spec-cursor", this.inner);
    this.sel = el("div", "spec-sel", this.inner);
    this.sel.hidden = true;
    this.regionLayer = el("div", "spec-regions", this.inner) as HTMLDivElement;
    this.hintEl = el("div", "spec-hint muted", this.root) as HTMLDivElement;
    parent.appendChild(this.root);

    this.scroll.addEventListener("scroll", () => this.schedule());
    new ResizeObserver(() => this.schedule()).observe(this.scroll);
    // Ctrl/⌘ + wheel (or trackpad pinch) zooms around the pointer.
    // Wheel / trackpad: Ctrl/⌘ (or pinch) zooms; scrolling moves along the recording.
    // Vertical scrolling is turned into horizontal movement while there is room to
    // move, so a normal two-finger swipe works; at either end the page scrolls.
    this.scroll.addEventListener("wheel", (e) => {
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.scroll.clientWidth : 1;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.zoomAround(this.pxPerSec * Math.exp(-e.deltaY * unit * 0.01), e.clientX);
        return;
      }
      const dx = e.deltaX * unit, dy = e.deltaY * unit;
      if (Math.abs(dy) <= Math.abs(dx)) return; // horizontal swipe: native scrolling
      const max = this.scroll.scrollWidth - this.scroll.clientWidth;
      const sl = this.scroll.scrollLeft;
      if ((dy > 0 && sl >= max - 1) || (dy < 0 && sl <= 0)) return; // at the edge: let the page scroll
      e.preventDefault();
      this.scroll.scrollLeft = Math.max(0, Math.min(max, sl + dy));
    }, { passive: false });
    this.installGestures();
    this.updateButtons();
  }


  /** Pointer gestures on the canvas (mouse, touch and pen):
   *  - drag: select a range (Select mode, or always with a mouse) or scroll (Scroll mode);
   *  - long-press then drag (touch): select even in Scroll mode;
   *  - two fingers: pinch to zoom, move to scroll;
   *  - tap/click without moving: onTap(time). */
  private installGestures() {
    const c = this.canvas;
    const pts = new Map<number, { x: number; y: number }>();
    let g: null | { id: number; kind: "pending" | "select" | "pan"; x0: number; y0: number; scroll0: number; anchor: number; timer: number; isMouse: boolean } = null;
    let pinch: null | { d0: number; px0: number; tAnchor: number } = null;
    const toT = (clientX: number) => {
      const r = this.inner.getBoundingClientRect();
      return Math.max(0, Math.min(this.duration, (clientX - r.left) / this.pxPerSec));
    };
    const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };
    const mid = () => { const [a, b] = [...pts.values()]; return (a.x + b.x) / 2; };
    const startSelect = () => {
      if (!g) return;
      g.kind = "select";
      this.showSel(g.anchor, g.anchor);
      if (!g.isMouse) navigator.vibrate?.(15);
    };
    c.addEventListener("pointerdown", (e) => {
      if (e.button > 0) return;
      try { c.setPointerCapture(e.pointerId); } catch { /* capture is a nicety, not required */ }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        if (g) { clearTimeout(g.timer); if (g.kind === "select") this.sel.hidden = true; }
        g = null;
        const r = this.scroll.getBoundingClientRect();
        pinch = { d0: dist(), px0: this.pxPerSec, tAnchor: (this.scroll.scrollLeft + mid() - r.left) / this.pxPerSec };
        return;
      }
      if (pts.size > 2) return;
      const isMouse = e.pointerType === "mouse";
      g = { id: e.pointerId, kind: "pending", x0: e.clientX, y0: e.clientY, scroll0: this.scroll.scrollLeft, anchor: toT(e.clientX), timer: 0, isMouse };
      if (!isMouse && this.dragMode === "scroll") {
        g.timer = window.setTimeout(() => { if (g && g.kind === "pending") startSelect(); }, 450);
      }
    });
    c.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pts.size === 2) {
        const r = this.scroll.getBoundingClientRect();
        this.pxPerSec = Math.max(2, Math.min(1500, pinch.px0 * (dist() / pinch.d0)));
        this.layout();
        this.scroll.scrollLeft = Math.max(0, pinch.tAnchor * this.pxPerSec - (mid() - r.left));
        return;
      }
      if (!g || e.pointerId !== g.id) return;
      const dx = e.clientX - g.x0, moved = Math.abs(dx) > (g.isMouse ? 3 : 8) || Math.abs(e.clientY - g.y0) > 8;
      if (g.kind === "pending" && moved) {
        clearTimeout(g.timer);
        if (this.dragMode === "select") startSelect();
        else g.kind = "pan";
      }
      if (g.kind === "pan") this.scroll.scrollLeft = Math.max(0, g.scroll0 - dx);
      else if (g.kind === "select") {
        const t = toT(e.clientX);
        this.showSel(Math.min(g.anchor, t), Math.max(g.anchor, t));
        this.edgeScroll(e.clientX);
      }
    });
    const end = (e: PointerEvent, cancelled: boolean) => {
      pts.delete(e.pointerId);
      if (pinch) { if (pts.size < 2) pinch = null; return; }
      if (!g || e.pointerId !== g.id) return;
      clearTimeout(g.timer);
      const done = g; g = null;
      if (cancelled) { if (done.kind === "select") this.sel.hidden = true; return; }
      if (done.kind === "pending") { this.onTap?.(toT(e.clientX)); return; }
      if (done.kind === "select") {
        const t = toT(e.clientX), a = Math.min(done.anchor, t), b = Math.max(done.anchor, t);
        this.sel.hidden = true;
        if (b - a >= MIN_REGION_S) this.onSelect?.(a, b);
      }
    };
    c.addEventListener("pointerup", (e) => end(e, false));
    c.addEventListener("pointercancel", (e) => end(e, true));
    c.addEventListener("contextmenu", (e) => e.preventDefault()); // long-press on touch
  }

  /** While dragging near the edge of the view, keep scrolling. */
  private edgeScroll(clientX: number) {
    const r = this.scroll.getBoundingClientRect(), zone = 28;
    if (clientX < r.left + zone) this.scroll.scrollLeft -= 12;
    else if (clientX > r.right - zone) this.scroll.scrollLeft += 12;
  }

  /** Marked ranges (examples, candidates, the pending selection). */
  setRegions(rs: Region[]) {
    this.regions = rs.map((r) => ({ ...r }));
    this.renderRegions();
  }

  private renderRegions() {
    const L = this.regionLayer;
    L.innerHTML = "";
    for (const r of this.regions) {
      const box = el("div", "rg" + (r.editable ? " editable" : ""), L);
      box.style.setProperty("--c", r.color);
      const place = () => {
        box.style.left = `${r.t0 * this.pxPerSec}px`;
        box.style.width = `${Math.max(2, (r.t1 - r.t0) * this.pxPerSec)}px`;
      };
      place();
      (box as HTMLElement & { place?: () => void }).place = place;
      const top = el("div", "rg-top", box);
      if (r.playable) {
        const b = el("button", "rg-btn", top); b.textContent = "▶"; b.title = "Play this part";
        b.onclick = (e) => { e.stopPropagation(); this.onRegionPlay?.(r.id); };
      }
      if (r.label) el("span", "rg-label", top).textContent = r.label;
      if (r.action) {
        const b = el("button", "rg-btn rg-action", top); b.textContent = r.action.text; b.title = r.action.title;
        b.onclick = (e) => { e.stopPropagation(); r.action!.run(); };
      }
      if (r.deletable) {
        const b = el("button", "rg-btn", top); b.textContent = "✕"; b.title = "Remove";
        b.onclick = (e) => { e.stopPropagation(); this.onRegionDelete?.(r.id); };
      }
      if (!r.editable) continue;
      for (const side of ["l", "r"] as const) {
        const h = el("div", `rg-h rg-h-${side}`, box);
        h.title = "Drag to resize";
        h.addEventListener("pointerdown", (e) => {
          e.stopPropagation(); e.preventDefault();
          h.setPointerCapture(e.pointerId);
          box.classList.add("dragging");
          const move = (ev: PointerEvent) => {
            const rect = this.inner.getBoundingClientRect();
            const t = Math.max(0, Math.min(this.duration, (ev.clientX - rect.left) / this.pxPerSec));
            if (side === "l") r.t0 = Math.min(t, r.t1 - MIN_REGION_S);
            else r.t1 = Math.max(t, r.t0 + MIN_REGION_S);
            place();
            this.edgeScroll(ev.clientX);
          };
          const up = () => {
            h.removeEventListener("pointermove", move);
            h.removeEventListener("pointerup", up);
            h.removeEventListener("pointercancel", up);
            box.classList.remove("dragging");
            this.onRegionChange?.(r.id, r.t0, r.t1);
          };
          h.addEventListener("pointermove", move);
          h.addEventListener("pointerup", up);
          h.addEventListener("pointercancel", up);
        });
      }
    }
  }

  getView(): SpecViewState { return { pxPerSec: this.pxPerSec, scrollLeft: this.scroll.scrollLeft }; }

  setView(v: SpecViewState) {
    this.pxPerSec = v.pxPerSec;
    this.layout();
    this.scroll.scrollLeft = v.scrollLeft;
  }

  /** Show a recording. `band` is the detector band (marked in the sound view and
   *  used for the detector view). */
  setData(pcm: Int16Array, band: SpecBand) {
    this.pcm = pcm; this.band = band;
    this.duration = pcm.length / DISPLAY_SR;
    this.det = null;
    const d: DisplaySpec = displaySpectrogram(pcm);
    this.sound = { data: d.data, frames: d.frames, bins: d.bins, hzLo: 0, hzPerBin: d.hzPerBin, showLo: SOUND_HZ_LO, showHi: DISPLAY_SR / 2 };
    this.legendText(d.dbHi - d.dbLo);
    const viewW = this.scroll.clientWidth || 800;
    this.pxPerSec = this.duration <= 180 ? Math.max(2, viewW / Math.max(0.5, this.duration)) : 25;
    this.layout();
  }

  setMode(m: Mode) {
    this.mode = m;
    if (m === "detector" && !this.det && this.pcm && this.band) {
      const f = getFeatures(this.pcm, this.band.binLo, this.band.binHi);
      const { q, lo, hi } = autoLevels(f.data, 0.5, 0.997);
      this.detRange = [lo, hi];
      const hzPerBin = DISPLAY_SR / 512, hzLo = this.band.binLo * hzPerBin;
      this.det = { data: q, frames: f.frames, bins: f.bins, hzLo, hzPerBin, showLo: hzLo, showHi: hzLo + f.bins * hzPerBin };
    }
    this.legendText();
    this.updateButtons();
    this.schedule();
  }

  /** Read-only overlays (kept for callers that only need highlights). */
  setOverlays(o: Overlay[]) {
    this.setRegions(o.map((x, i) => ({ id: `ov${i}`, t0: x.t0, t1: x.t1, color: x.color, label: x.label })));
  }

  setCursor(t: number | null) {
    this.cursorT = t;
    this.cursor.style.display = t === null ? "none" : "block";
    if (t === null) return;
    const x = t * this.pxPerSec;
    this.cursor.style.left = `${x}px`;
    const x0 = this.scroll.scrollLeft, w = this.scroll.clientWidth;
    if (x < x0 || x > x0 + w - 30) this.scroll.scrollLeft = Math.max(0, x - w * 0.2);
  }

  clearSelection() { this.sel.hidden = true; }

  showSel(a: number, b: number) {
    this.sel.hidden = false;
    this.sel.dataset.t0 = String(a); this.sel.dataset.t1 = String(b);
    this.sel.style.left = `${a * this.pxPerSec}px`;
    this.sel.style.width = `${Math.max(1, (b - a) * this.pxPerSec)}px`;
  }

  scrollTo(t: number) {
    this.scroll.scrollLeft = Math.max(0, t * this.pxPerSec - this.scroll.clientWidth / 2);
  }

  fit() {
    const w = this.scroll.clientWidth || 800;
    this.pxPerSec = Math.max(2, w / Math.max(0.5, this.duration));
    this.layout();
    this.scroll.scrollLeft = 0;
  }

  private zoomAround(px: number, clientX?: number) {
    const r = this.scroll.getBoundingClientRect();
    const ax = clientX === undefined ? r.width / 2 : clientX - r.left;
    const tAt = (this.scroll.scrollLeft + ax) / this.pxPerSec;
    this.pxPerSec = Math.max(2, Math.min(1500, px));
    this.layout();
    this.scroll.scrollLeft = Math.max(0, tAt * this.pxPerSec - ax);
  }

  private legendText(rangeDb?: number) {
    if (this.mode === "detector") {
      const [lo, hi] = this.detRange;
      this.legend.textContent = `${this.band?.loHz ?? ""}–${this.band?.hiHz ?? ""} Hz vs. background · bright = ${Math.round(hi - lo)} dB above`;
      this.legend.title = "The detector only looks at its frequency band and compares each moment with the slowly adapting background level, so steady noise fades to dark.";
    } else {
      const r = rangeDb ?? 0;
      this.legend.textContent = r ? `brighter = louder (${Math.round(r)} dB range, auto)` : "brighter = louder";
      this.legend.title = "Pitch on a perceptual (mel) scale; contrast is set automatically for each recording.";
    }
  }

  private updateButtons() {
    for (const m of ["sound", "detector"] as Mode[]) this.modeBtns[m].classList.toggle("on", this.mode === m);
    if (this.dragBtns) for (const m of ["scroll", "select"] as DragMode[]) this.dragBtns[m].classList.toggle("on", this.dragMode === m);
    if (this.hintEl) {
      this.hintEl.textContent = this.dragMode === "select"
        ? "Drag across a sound to select it; scroll or swipe to move along, Ctrl/⌘ + scroll or pinch to zoom. Tap/click to play from there. Drag the edges of a marked part to resize it."
        : (COARSE ? "Swipe to move, pinch to zoom, long-press then drag to select. Tap to play from there. Drag the edges of a marked part to resize it."
                  : "Drag or scroll (two-finger swipe) to move along the recording; Ctrl/⌘ + scroll or pinch zooms. Click to play from there.");
      this.canvas.style.cursor = this.dragMode === "scroll" ? "grab" : "crosshair";
    }
  }

  private layout() {
    this.inner.style.width = `${Math.max(1, Math.round(this.duration * this.pxPerSec))}px`;
    if (this.cursorT !== null) this.cursor.style.left = `${this.cursorT * this.pxPerSec}px`;
    if (!this.sel.hidden) this.showSel(Number(this.sel.dataset.t0), Number(this.sel.dataset.t1));
    for (const b of Array.from(this.regionLayer.children)) (b as HTMLElement & { place?: () => void }).place?.();
    this.schedule();
  }

  private schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

  private draw() {
    const viewW = Math.max(1, Math.min(this.scroll.clientWidth, Math.round(this.duration * this.pxPerSec)) || 1);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const c = this.canvas;
    c.style.width = `${viewW}px`; c.style.height = `${H + AX}px`;
    c.width = Math.round(viewW * dpr); c.height = Math.round((H + AX) * dpr);
    const g = c.getContext("2d")!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = "#000004";
    g.fillRect(0, 0, c.width, c.height);
    const x0 = this.scroll.scrollLeft;
    const grid = this.mode === "sound" ? this.sound : this.det;
    if (grid && grid.frames > 0) {
      // Image at CSS resolution: each column takes the max over the frames it covers,
      // each row the max over the bins it covers.
      const img = g.createImageData(viewW, H);
      const fpp = FPS / this.pxPerSec;
      // Row y (0 = top) covers a mel-spaced frequency slice -> bin range [rowA, rowB).
      const mLo = mel(grid.showLo), mHi = mel(grid.showHi);
      const rowA = new Int32Array(H), rowB = new Int32Array(H);
      for (let y = 0; y < H; y++) {
        const hzBot = imel(mLo + ((H - 1 - y) / H) * (mHi - mLo)), hzTop = imel(mLo + ((H - y) / H) * (mHi - mLo));
        const a = Math.max(0, Math.min(grid.bins - 1, Math.floor((hzBot - grid.hzLo) / grid.hzPerBin)));
        rowA[y] = a;
        rowB[y] = Math.min(grid.bins, Math.max(a + 1, Math.ceil((hzTop - grid.hzLo) / grid.hzPerBin)));
      }
      for (let x = 0; x < viewW; x++) {
        const fa = Math.floor((x0 + x) * fpp);
        if (fa >= grid.frames) break;
        const fb = Math.min(grid.frames, Math.max(fa + 1, Math.floor((x0 + x + 1) * fpp)));
        for (let y = 0; y < H; y++) {
          const ba = rowA[y], bb = rowB[y];
          let v = 0;
          for (let f = fa; f < fb; f++) {
            const base = f * grid.bins;
            for (let b = ba; b < bb; b++) { const d = grid.data[base + b]; if (d > v) v = d; }
          }
          const o = (y * viewW + x) * 4;
          img.data[o] = LUT[v * 3]; img.data[o + 1] = LUT[v * 3 + 1]; img.data[o + 2] = LUT[v * 3 + 2]; img.data[o + 3] = 255;
        }
      }
      const tmp = document.createElement("canvas");
      tmp.width = viewW; tmp.height = H;
      tmp.getContext("2d")!.putImageData(img, 0, 0);
      g.imageSmoothingEnabled = false;
      g.drawImage(tmp, 0, 0, c.width, Math.round(H * dpr));
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.font = "11px system-ui, sans-serif";
    g.textBaseline = "middle";
    // Frequency axis + detector band.
    if (grid) {
      const mLo = mel(grid.showLo), mHi = mel(grid.showHi);
      const yOf = (hz: number) => H - ((mel(hz) - mLo) / (mHi - mLo)) * H;
      for (const hz of FREQ_TICKS) {
        if (hz <= grid.showLo || hz >= grid.showHi) continue;
        const y = yOf(hz);
        if (y < 8 || y > H - 4) continue;
        g.fillStyle = "rgba(255,255,255,.18)"; g.fillRect(0, Math.round(y), viewW, 1);
        const label = hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`;
        g.fillStyle = "rgba(0,0,4,.65)"; g.fillRect(2, y - 7, g.measureText(label).width + 6, 14);
        g.fillStyle = "rgba(255,255,255,.92)";
        g.fillText(label, 5, y);
      }
      if (this.mode === "sound" && this.band) {
        g.strokeStyle = "rgba(120,200,255,.9)"; g.setLineDash([5, 4]);
        for (const hz of [this.band.loHz, this.band.hiHz]) {
          const y = Math.round(yOf(hz)) + 0.5;
          g.beginPath(); g.moveTo(0, y); g.lineTo(viewW, y); g.stroke();
        }
        g.setLineDash([]);
        g.fillStyle = "rgba(120,200,255,.95)"; g.textAlign = "right";
        g.fillText("detector band", viewW - 6, yOf(this.band.hiHz) - 8);
        g.textAlign = "left";
      }
    }
    // Time axis: adaptive tick spacing.
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const tStep = steps.find((s) => s * this.pxPerSec >= 80) ?? 600;
    const tA = x0 / this.pxPerSec, tB = (x0 + viewW) / this.pxPerSec;
    g.textBaseline = "middle";
    g.fillStyle = "#11151f"; g.fillRect(0, H, viewW, AX);
    for (let t = Math.ceil(tA / tStep) * tStep; t <= tB; t += tStep) {
      const x = Math.round(t * this.pxPerSec - x0);
      g.fillStyle = "rgba(255,255,255,.12)"; g.fillRect(x, 0, 1, H);
      g.fillStyle = "rgba(255,255,255,.5)"; g.fillRect(x, H, 1, 5);
      g.fillStyle = "rgba(255,255,255,.85)";
      g.fillText(fmtTime(t, tStep), x + 3, H + AX / 2 + 1);
    }
  }
}

export interface TimelineEvent { type: string; t: number; score: number }

export class Timeline {
  canvas = document.createElement("canvas");
  onSeek: ((t: number) => void) | null = null;
  private scores: Float32Array = new Float32Array(0);
  private firstFrame = 81;
  private events: TimelineEvent[] = [];
  private spans: Overlay[] = [];
  private duration = 0;

  constructor(parent: HTMLElement) {
    this.canvas.className = "timeline";
    this.canvas.style.height = "110px";
    parent.appendChild(this.canvas);
    this.canvas.addEventListener("click", (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.onSeek?.(Math.max(0, ((e.clientX - r.left) / r.width) * this.duration));
    });
    new ResizeObserver(() => this.draw()).observe(this.canvas);
  }

  setData(scores: Float32Array, firstFrame: number, events: TimelineEvent[], spans: Overlay[], duration: number) {
    this.scores = scores; this.firstFrame = firstFrame;
    this.events = events; this.spans = spans; this.duration = duration;
    this.draw();
  }

  private draw() {
    const c = this.canvas;
    const W = Math.max(50, c.clientWidth || 600), H = 110;
    c.width = W; c.height = H;
    const g = c.getContext("2d")!;
    const dark = document.documentElement.dataset.theme !== "light";
    g.fillStyle = dark ? "#0b1020" : "#eef1f6";
    g.fillRect(0, 0, W, H);
    const X = (t: number) => (t / Math.max(1e-6, this.duration)) * W;
    const Y = (s: number) => H - 8 - Math.max(0, Math.min(1, s)) * (H - 20);
    for (const s of this.spans) {
      g.fillStyle = s.color + "44";
      g.fillRect(X(s.t0), 0, X(s.t1) - X(s.t0), H);
    }
    // threshold gridlines
    g.strokeStyle = dark ? "#334" : "#bbc";
    g.beginPath(); g.moveTo(0, Y(0.55)); g.lineTo(W, Y(0.55)); g.stroke();
    // scores
    g.strokeStyle = "#4da3ff";
    g.beginPath();
    const fps = 62.5;
    for (let i = 0; i < this.scores.length; i++) {
      const t = ((this.firstFrame + i) / fps);
      const x = X(t), y = Y(this.scores[i]);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
    // events
    for (const e of this.events) {
      const x = X(e.t);
      g.fillStyle = e.type === "unit" ? "#3ddc84" : e.type === "near" ? "#ffbf3f" : e.type === "alarm_on" ? "#ff5d5d" : "#999";
      if (e.type === "alarm_on" || e.type === "alarm_off") {
        g.fillRect(x - 1, 0, 2, H);
      } else {
        g.beginPath(); g.arc(x, Y(e.score), 3.5, 0, 7); g.fill();
      }
    }
  }
}
