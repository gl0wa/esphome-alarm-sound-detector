// Canvas widgets: spectrogram (scroll/zoom/select) and evaluation timeline.

const LUT_R = new Uint8Array(256), LUT_G = new Uint8Array(256), LUT_B = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  const t = i / 255;
  // dark blue -> teal -> yellow -> red
  LUT_R[i] = Math.round(255 * Math.min(1, Math.max(0, 1.6 * t - 0.25)));
  LUT_G[i] = Math.round(255 * Math.min(1, Math.max(0, 1.9 * t - 0.55)));
  LUT_B[i] = Math.round(255 * Math.min(1, Math.max(0, 0.9 - 1.7 * t)));
}

export interface Overlay { t0: number; t1: number; color: string; label?: string }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  parent.appendChild(e);
  return e;
}

export class SpecView {
  root = document.createElement("div");
  private scroll: HTMLDivElement;
  private canvas = document.createElement("canvas");
  private cursor: HTMLDivElement;
  private sel: HTMLDivElement;
  private feat: Float32Array = new Float32Array(0);
  private frames = 0;
  private bins = 0;
  private duration = 0;
  pxPerSec = 120;
  private overlays: Overlay[] = [];
  private img: ImageData | null = null;
  onSelect: ((t0: number, t1: number) => void) | null = null;

  constructor(parent: HTMLElement, hint: string) {
    this.root.className = "spec";
    const bar = el("div", "spec-bar", this.root);
    const hintEl = el("span", "muted", bar);
    hintEl.textContent = hint;
    const zoomOut = el("button", "", bar); zoomOut.textContent = "−";
    const zoomIn = el("button", "", bar); zoomIn.textContent = "+";
    zoomOut.onclick = () => this.setZoom(this.pxPerSec / 1.4);
    zoomIn.onclick = () => this.setZoom(this.pxPerSec * 1.4);
    this.scroll = el("div", "spec-scroll", this.root) as HTMLDivElement;
    const inner = el("div", "spec-inner", this.scroll);
    this.canvas.style.height = "180px";
    inner.appendChild(this.canvas);
    this.cursor = el("div", "spec-cursor", inner);
    this.sel = el("div", "spec-sel", inner);
    this.sel.hidden = true;
    parent.appendChild(this.root);
    // drag to select
    let anchor: number | null = null;
    const toT = (e: MouseEvent) => {
      const r = this.canvas.getBoundingClientRect();
      return Math.max(0, Math.min(this.duration, (e.clientX - r.left) / this.pxPerSec));
    };
    this.canvas.addEventListener("pointerdown", (e) => {
      anchor = toT(e);
      this.canvas.setPointerCapture(e.pointerId);
      this.showSel(anchor, anchor);
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (anchor === null) return;
      this.showSel(Math.min(anchor, toT(e)), Math.max(anchor, toT(e)));
    });
    this.canvas.addEventListener("pointerup", (e) => {
      if (anchor === null) return;
      const t = toT(e);
      const a = Math.min(anchor, t), b = Math.max(anchor, t);
      anchor = null;
      if (b - a > 0.05) this.onSelect?.(a, b);
      else this.sel.hidden = true;
    });
  }

  setZoom(px: number) {
    this.pxPerSec = Math.max(10, Math.min(1200, px));
    this.layout();
  }

  setData(feat: Float32Array, frames: number, bins: number, duration: number) {
    this.feat = feat; this.frames = frames; this.bins = bins; this.duration = duration;
    this.img = null;
    this.layout();
  }

  setOverlays(o: Overlay[]) {
    this.overlays = o;
    this.draw();
  }

  setCursor(t: number | null) {
    this.cursor.style.display = t === null ? "none" : "block";
    if (t !== null) this.cursor.style.left = `${t * this.pxPerSec}px`;
  }

  clearSelection() { this.sel.hidden = true; }

  showSel(a: number, b: number) {
    this.sel.hidden = false;
    this.sel.style.left = `${a * this.pxPerSec}px`;
    this.sel.style.width = `${Math.max(1, (b - a) * this.pxPerSec)}px`;
  }

  scrollTo(t: number) {
    this.scroll.scrollLeft = Math.max(0, t * this.pxPerSec - this.scroll.clientWidth / 2);
  }

  private layout() {
    const w = Math.max(50, Math.round(this.duration * this.pxPerSec));
    this.canvas.width = w;
    this.canvas.style.width = `${w}px`;
    (this.canvas.parentElement as HTMLElement).style.width = `${w}px`;
    this.draw();
  }

  private draw() {
    const c = this.canvas;
    const g = c.getContext("2d")!;
    const H = 180;
    c.height = H;
    g.fillStyle = "#0b1020";
    g.fillRect(0, 0, c.width, H);
    if (this.frames > 1 && this.bins > 0) {
      const cols = Math.min(c.width, 4000);
      const img = g.createImageData(cols, H);
      const fPerPx = this.frames / c.width;
      for (let x = 0; x < cols; x++) {
        const cx = Math.floor((x / cols) * c.width);
        const f = Math.min(this.frames - 1, Math.floor(cx * fPerPx));
        for (let y = 0; y < H; y++) {
          const b = Math.floor(((H - 1 - y) / H) * this.bins);
          const v = this.feat[f * this.bins + Math.min(b, this.bins - 1)] ?? 0;
          const li = Math.max(0, Math.min(255, (v / 36 * 255) | 0));
          const o = (y * cols + x) * 4;
          img.data[o] = LUT_R[li];
          img.data[o + 1] = LUT_G[li];
          img.data[o + 2] = LUT_B[li];
          img.data[o + 3] = 255;
        }
      }
      // stretch blit
      const tmp = document.createElement("canvas");
      tmp.width = cols; tmp.height = H;
      tmp.getContext("2d")!.putImageData(img, 0, 0);
      g.imageSmoothingEnabled = true;
      g.drawImage(tmp, 0, 0, c.width, H);
    }
    // time gridlines each 5 s
    g.fillStyle = "rgba(255,255,255,.55)";
    g.font = "10px system-ui";
    for (let t = 0; t <= this.duration; t += 5) {
      const x = t * this.pxPerSec;
      g.fillRect(x, 0, 1, H);
      g.fillText(`${t}s`, x + 3, 11);
    }
    // overlays
    for (const o of this.overlays) {
      const x = o.t0 * this.pxPerSec, w = Math.max(2, (o.t1 - o.t0) * this.pxPerSec);
      g.fillStyle = o.color + "55";
      g.fillRect(x, 0, w, H);
      g.strokeStyle = o.color;
      g.strokeRect(x + 0.5, 0.5, w - 1, H - 1);
      if (o.label) { g.fillStyle = o.color; g.fillText(o.label, x + 3, H - 6); }
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
