// "Create a preset" flow: temporary recording firmware -> phone recording ->
// the existing Recordings/Examples/Build/Evaluate steps -> Export (install first).
import qrcode from "qrcode-generator";
import { button, download, h, note } from "../helpers";
import { DeviceSettings, YamlPreset, buildDeviceYaml, captureLink, getRoute, setRoute } from "../device";
export { getRoute, setRoute } from "../device";
import { renderDeviceCard } from "./deviceCard";
import { State } from "../store";
import { renderRecordings } from "./recordings";
import { renderExamples } from "./examples";
import { renderBuild } from "./build";
import { renderEvaluate } from "./evaluate";
import { renderExport } from "./exportView";

export const CREATE_STEPS = [
  "Record with the device",
  "(merged into step 0)",
  "Mark the alarm",
  "Find more examples",
  "Build",
  "Test",
  "Install",
] as const;

/** Internal step indices shown for the current route. */
function visibleSteps(): number[] {
  return getRoute() === "file" ? [2, 3, 4, 5, 6] : [0, 2, 3, 4, 5, 6];
}

/** Step name; the first step of the phone/laptop route also adds the audio. */
export function stepName(i: number): string {
  if (i === 2 && getRoute() === "file") return "Add audio & mark the alarm";
  return CREATE_STEPS[i];
}

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
  const vis = visibleSteps();
  if (!vis.includes(getCreateStep())) setCreateStep(vis[0]);
  const step = getCreateStep();
  const pos = vis.indexOf(step);
  h("h2", "", root, `Create a preset · step ${pos + 1} of ${vis.length}: ${stepName(step)}`);

  const sub = h("nav", "tabs", root);
  vis.forEach((i, k) => {
    const b = h("button", i === step ? "tab active" : "tab", sub, `${k + 1} · ${stepName(i)}`);
    b.onclick = () => { setCreateStep(i); opts.rerenderCreate(); };
  });

  const body = h("div", "", root);
  const go = (i: number) => { setCreateStep(i); opts.rerenderCreate(); window.scrollTo({ top: 0, behavior: "smooth" }); };

  if (step === 0) {
    note(body, "A temporary firmware for recording — the only one that can send sound, and only while you record " +
      "(over your home network, protected by the key in the QR code). The last step installs the normal, private firmware again.");
    const skip = h("p", "note", body, "Recording with a phone or laptop, or loading audio files instead? ");
    const sk = h("a", "", skip, "Skip the device →") as HTMLAnchorElement;
    sk.href = "#"; sk.onclick = (e) => { e.preventDefault(); setRoute("file"); go(2); };

    h("h3", "", body, "1. Install the recording firmware");
    renderDeviceCard(body, dev, () => renderCreate(root, s, dev, opts));
    const yaml = buildDeviceYaml(dev, [] as YamlPreset[], true);
    const row = h("div", "row", body);
    button(row, "Copy YAML", async () => {
      try { await navigator.clipboard.writeText(yaml); msg.textContent = "Copied."; }
      catch { msg.textContent = "Copy failed; open “Show the YAML” and select the text."; }
    }, "primary");
    button(row, "Download YAML", () => download(`${dev.deviceName}-recording.yaml`, yaml));
    const msg = h("span", "muted", row, "");
    msg.setAttribute("role", "status");
    const ol = h("ol", "steps-list", body);
    h("li", "", ol, "In the ESPHome dashboard: New device → paste this YAML (or replace the YAML of the existing device).");
    h("li", "", ol, "Make sure ESPHome's secrets contain wifi_ssid and wifi_password.");
    h("li", "", ol, "Install (the first install is over USB, later ones over Wi-Fi).");
    const yd = h("details", "", body);
    h("summary", "", yd, "Show the YAML");
    h("pre", "snippet", yd, yaml);

    h("h3", "", body, "2. Record through the device — from your phone or computer");
    const ul = h("ul", "compact-list", body);
    h("li", "", ul, "The ESP32's microphone records; your phone or computer browser only starts, stops and collects the clips.");
    h("li", "", ul, "Put the device where it will finally listen — same room, same distance to the appliance.");
    h("li", "", ul, "Open the page below, record the alarm a few times plus some everyday background, then press “Send to preset studio”.");
    const qrs = h("div", "qr-row", body);
    const qrCard = (title: string, link: string) => {
      const c = h("div", "qr-card", qrs);
      h("strong", "", c, title);
      const box = h("div", "qr-box", c);
      renderQr(box, link);
      const a = h("a", "qr-link", c, link) as HTMLAnchorElement;
      a.href = link; a.target = "_blank"; a.rel = "noopener";
      return c;
    };
    qrCard("Computer or iPhone: open the link or scan", captureLink(dev.deviceName, dev.captureKey, ""));
    const ipCard = h("div", "qr-card", qrs);
    h("strong", "", ipCard, "If the page doesn't open (most Android phones)");
    note(ipCard, "Android often can't open .local names. Enter the device's IP address (ESPHome dashboard or your router shows it):");
    const ipWrap = h("label", "field", ipCard);
    h("span", "", ipWrap, "Device IP address");
    const ip = h("input", "", ipWrap) as HTMLInputElement;
    ip.placeholder = "e.g. 192.168.1.42";
    ip.inputMode = "decimal";
    ip.value = loadIp();
    const ipQr = h("div", "", ipCard);
    const drawIp = () => {
      ipQr.innerHTML = "";
      const v = ip.value.trim();
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) {
        if (v) note(ipQr, "Enter an address like 192.168.1.42.");
        return;
      }
      const link = captureLink(dev.deviceName, dev.captureKey, v);
      const box = h("div", "qr-box", ipQr);
      renderQr(box, link);
      const a = h("a", "qr-link", ipQr, link) as HTMLAnchorElement;
      a.href = link; a.target = "_blank"; a.rel = "noopener";
    };
    ip.oninput = () => {
      try { localStorage.setItem(IP_KEY, ip.value.trim()); } catch { /* ignore */ }
      drawIp();
    };
    drawIp();
  }

  if (step === 0) { /* rendered above */ }
  else if (step === 2) renderRecordings(body, s, { refresh: opts.refresh });
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
  const prev = vis[pos - 1], next = vis[pos + 1];
  navRow(
    body,
    prev !== undefined ? { label: stepName(prev), go: () => go(prev) } : undefined,
    next !== undefined ? { label: `Next: ${stepName(next)}`, go: () => go(next) } : undefined,
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
