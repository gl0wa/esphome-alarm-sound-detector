// Small DOM helpers shared by the views.
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
  type?: string; step?: string; onChange?: (v: string) => void; title?: string;
}): HTMLInputElement {
  const wrap = h("label", "field", parent);
  h("span", "", wrap, label);
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
