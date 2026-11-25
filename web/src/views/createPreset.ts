// "Create a preset" flow: temporary recording firmware -> phone recording ->
// the existing Recordings/Examples/Build/Evaluate steps -> Export (install first).
import qrcode from "qrcode-generator";
import { button, download, h, note } from "../helpers";
import { DeviceSettings, YamlPreset, buildDeviceYaml, captureLink } from "../device";
import { renderDeviceCard } from "./deviceCard";
import { State } from "../store";
import { renderRecordings } from "./recordings";
import { renderExamples } from "./examples";
import { renderBuild } from "./build";
import { renderEvaluate } from "./evaluate";
import { renderExport } from "./exportView";

export const CREATE_STEPS = [
  "Install recording firmware",
  "Record with your phone",
  "Recordings",
  "Examples",
  "Build",
  "Evaluate",
  "Export & install",
] as const;

export function getCreateStep(): number {
  return (renderCreate as { step?: number }).step ?? 0;
}
export function setCreateStep(i: number) {
  (renderCreate as { step?: number }).step = Math.max(0, Math.min(CREATE_STEPS.length - 1, i));
}

const IP_KEY = "asd-studio-ip-v1";
function loadIp(): string {
  try {
    return localStorage.getItem(IP_KEY) ?? "";
  } catch { return ""; }
}

function renderQr(box: HTMLElement, text: string) {
  box.innerHTML = "";
  try {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    box.innerHTML = qr.createSvgTag({ scalable: true });
    const svg = box.querySelector("svg");
    if (svg) {
      svg.setAttribute("width", "180");
      svg.setAttribute("height", "180");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", `QR code for ${text}`);
    }
  } catch {
    note(box, "QR code failed to render — use the link below instead.");
  }
}

export function renderCreate(
  root: HTMLElement,
  s: State,
  dev: DeviceSettings,
  opts: { refresh: () => void; rerenderCreate: () => void },
) {
  root.innerHTML = "";
  const step = getCreateStep();
  h("h2", "", root, `Create a preset · ${step + 1} of ${CREATE_STEPS.length}: ${CREATE_STEPS[step]}`);

  const sub = h("nav", "tabs", root);
  CREATE_STEPS.forEach((name, i) => {
    const b = h("button", i === step ? "tab active" : "tab", sub, `${i + 1} · ${name}`);
    b.onclick = () => { setCreateStep(i); opts.rerenderCreate(); };
  });

  const body = h("div", "", root);
  const go = (i: number) => { setCreateStep(i); opts.rerenderCreate(); window.scrollTo({ top: 0, behavior: "smooth" }); };

  if (step === 0) {
    note(body, "This firmware is temporary: it is the ONLY firmware that can send sound — " +
      "to your browser only, only while you press Record, unencrypted over your home Wi-Fi " +
      "(protected by the key in the QR code on the next step). You will switch back to the private firmware at the end.");
    const skip = h("p", "note", body, "Recording with a phone or laptop, or loading audio files instead? ");
    const sk = h("a", "", skip, `Skip to ${CREATE_STEPS[2]} →`) as HTMLAnchorElement;
    sk.href = "#"; sk.onclick = (e) => { e.preventDefault(); go(2); };
    renderDeviceCard(body, dev, () => renderCreate(root, s, dev, opts));
    const yaml = buildDeviceYaml(dev, [] as YamlPreset[], true);
    const pre = h("pre", "snippet", body, yaml);
    const row = h("div", "row", body);
    const msg = h("span", "muted", row, "");
    button(row, "Copy recording YAML", async () => {
      try { await navigator.clipboard.writeText(yaml); msg.textContent = "Copied."; }
      catch { msg.textContent = "Copy failed; select the text above instead."; }
    }, "primary");
    button(row, "Download YAML", () => download(`${dev.deviceName}-recording.yaml`, yaml));
    void pre;
    navRow(body, undefined, { label: CREATE_STEPS[1], go: () => go(1) });
    return;
  }

  if (step === 1) {
    note(body, "Open this page on your phone, record the alarm several times plus everyday background sounds, " +
      "then tap “Send to preset studio”. Android often can't open .local names — enter the device IP address below if needed.");
    const link0 = captureLink(dev.deviceName, dev.captureKey, loadIp());
    const qrBox = h("div", "qr-box", body);
    renderQr(qrBox, link0);
    const linkRow = h("p", "", body);
    const a = h("a", "", linkRow, link0) as HTMLAnchorElement;
    a.href = link0;
    a.target = "_blank";
    a.rel = "noopener";
    const row = h("div", "row", body);
    button(row, "Copy link", async () => {
      try { await navigator.clipboard.writeText(a.href); } catch { /* ignore */ }
    });
    const ipWrap = h("label", "field", body);
    h("span", "", ipWrap, "Device IP address (optional, for phones that can't open .local)");
    const ip = h("input", "", ipWrap) as HTMLInputElement;
    ip.placeholder = "e.g. 192.168.1.42";
    ip.value = loadIp();
    ip.onchange = () => {
      try { localStorage.setItem(IP_KEY, ip.value.trim()); } catch { /* ignore */ }
      const link = captureLink(dev.deviceName, dev.captureKey, ip.value);
      a.href = link;
      a.textContent = link;
      renderQr(qrBox, link);
    };
    note(body, "Tip: one long session works best — several alarm episodes plus background (speech, clatter, other appliances). " +
      "The background is what the false-alarm check needs.");
    navRow(body, { label: CREATE_STEPS[0], go: () => go(0) }, { label: `Next: ${CREATE_STEPS[2]}`, go: () => go(2) });
    return;
  }

  if (step === 2) renderRecordings(body, s, { refresh: opts.refresh });
  else if (step === 3) renderExamples(body, s, opts.refresh);
  else if (step === 4) renderBuild(body, s, opts.refresh);
  else if (step === 5) renderEvaluate(body, s, opts.refresh);
  else renderExport(body, s, opts.refresh, dev);

  const blocked = [
    undefined, undefined,
    !s.recordings.length ? "Load a recording first." : !s.examples.length ? "Mark at least one example first." : undefined,
    !s.examples.length ? "Mark or accept at least one example first." : undefined,
    !s.template ? "Build the template first." : undefined,
    undefined, undefined,
  ][step];
  void blocked;
  navRow(
    body,
    step > 0 ? { label: CREATE_STEPS[step - 1], go: () => go(step - 1) } : undefined,
    step < CREATE_STEPS.length - 1 ? { label: `Next: ${CREATE_STEPS[step + 1]}`, go: () => go(step + 1) } : undefined,
  );
}

function navRow(
  parent: HTMLElement,
  back: { label: string; go: () => void } | undefined,
  next: { label: string; go: () => void } | undefined,
) {
  const nav = h("div", "step-nav", parent);
  if (back) button(nav, `← ${back.label}`, back.go, "secondary");
  h("span", "spacer", nav);
  if (next) button(nav, `${next.label} →`, next.go, "primary");
}
