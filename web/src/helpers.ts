// Small DOM helpers shared by the views.
import { helpIcon } from "./help";
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls: string, parent: HTMLElement, text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent.appendChild(e);
  return e;
}

export function button(parent: HTMLElement, label: string, fn: () => void, cls = ""): HTMLButtonElement {
  const b = h("button", cls, parent, label);
  b.onclick = fn;
  return b;
}

export function field(parent: HTMLElement, label: string, value: string | number, opts?: {
  type?: string; step?: string; onChange?: (v: string) => void; title?: string; help?: string;
}): HTMLInputElement {
  const wrap = h("label", "field", parent);
  const lab = h("span", "", wrap, label);
  if (opts?.help) helpIcon(lab, opts.help);
  const inp = h("input", "", wrap) as HTMLInputElement;
  inp.type = opts?.type ?? "text";
  if (opts?.step) inp.step = opts.step;
  inp.value = String(value);
  if (opts?.title) inp.title = opts.title;
  if (opts?.onChange) inp.onchange = () => opts.onChange!(inp.value);
  return inp;
}

export function note(parent: HTMLElement, text: string): HTMLElement {
  return h("p", "note", parent, text);
}

export function fmtT(t: number): string {
  return `${t.toFixed(2)}s`;
}

export function download(name: string, content: string | Blob) {
  const blob = typeof content === "string" ? new Blob([content], { type: "application/octet-stream" }) : content;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** Back / next buttons at the bottom of a step. */
export function stepNav(parent: HTMLElement, opts: {
  back?: { label: string; go: () => void };
  next?: { label: string; go: () => void; blockedReason?: string };
}): void {
  const nav = h("div", "step-nav", parent);
  if (opts.back) button(nav, `← ${opts.back.label}`, opts.back.go, "secondary");
  h("span", "spacer", nav);
  if (opts.next) {
    if (opts.next.blockedReason) h("span", "muted", nav, opts.next.blockedReason);
    const b = button(nav, `${opts.next.label} →`, opts.next.go, "primary");
    b.disabled = !!opts.next.blockedReason;
  }
}

/** Multi-line text field spanning the whole form row. */
export function textArea(parent: HTMLElement, label: string, value: string, opts?: {
  rows?: number; onChange?: (v: string) => void;
}): HTMLTextAreaElement {
  const wrap = h("label", "field wide", parent);
  h("span", "", wrap, label);
  const ta = h("textarea", "", wrap) as HTMLTextAreaElement;
  ta.rows = opts?.rows ?? 3;
  ta.value = value;
  if (opts?.onChange) ta.onchange = () => opts.onChange!(ta.value);
  return ta;
}
