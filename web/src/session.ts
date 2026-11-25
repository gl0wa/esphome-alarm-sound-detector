// Small shared status line for session saving (shown in the header and on the export page).
let el: HTMLElement | null = null;
let last = "", lastErr = false;

export function sessionStatusElement(): HTMLElement {
  el = document.createElement("span");
  el.className = "session-status muted";
  render();
  return el;
}

export function setSessionStatus(text: string, error = false) {
  last = text; lastErr = error;
  render();
}

function render() {
  if (!el) return;
  el.textContent = last;
  el.classList.toggle("warn", lastErr);
}
