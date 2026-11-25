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
  "Recording firmware",
  "Record on your phone",
  "Mark the alarm",
  "Find more examples",
  "Build",
  "Test",
  "Install",
] as const;

/** Internal step indices shown for the current route. */
function visibleSteps(): number[] {
  return getRoute() === "file" ? [2, 3, 4, 5, 6] : [0, 1, 2, 3, 4, 5, 6];
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
  h("h2", "", root, `Create a preset · step ${pos + 1} of ${vis.length}: ${CREATE_STEPS[step]}`);

  const sub = h("nav", "tabs", root);
  vis.forEach((i, k) => {
    const b = h("button", i === step ? "tab active" : "tab", sub, `${k + 1} · ${CREATE_STEPS[i]}`);
    b.onclick = () => { setCreateStep(i); opts.rerenderCreate(); };
  });

  const body = h("div", "", root);
  const go = (i: number) => { setCreateStep(i); opts.rerenderCreate(); window.scrollTo({ top: 0, behavior: "smooth" }); };

  if (step === 0) {
    note(body, "A temporary firmware for recording. It is the only firmware that can send sound: to your browser, " +
      "only while you press Record, over your home Wi-Fi (protected by the key in the next step's QR code). " +
      "The last step gives you the normal, private firmware again.");
    const skip = h("p", "note", body, "Recording with a phone or laptop, or loading audio files instead? ");
    const sk = h("a", "", skip, "Skip the device steps →") as HTMLAnchorElement;
    sk.href = "#"; sk.onclick = (e) => { e.preventDefault(); setRoute("file"); go(2); };
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
    const ol = h("ol", "steps-list", body);
    h("li", "", ol, "In the ESPHome dashboard: New device → paste this YAML (or replace the YAML of the existing device).");
    h("li", "", ol, "Make sure ESPHome's secrets contain wifi_ssid and wifi_password.");
    h("li", "", ol, "Install (the first install is over USB, later ones over Wi-Fi).");
    navRow(body, undefined, { label: CREATE_STEPS[1], go: () => go(1) });
    return;
  }

  if (step === 1) {
    note(body, "Scan with your phone. On the device's page, record the alarm a few times plus some everyday " +
      "background (talking, dishes, other appliances), then tap “Send to preset studio” — the clips arrive in the next step.");
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
    const ipDet = h("details", "", body);
    h("summary", "", ipDet, "Page doesn't open on the phone?");
    note(ipDet, "Some phones (often Android) can't open .local addresses. Enter the device's IP address " +
      "(shown in the ESPHome dashboard or your router) and scan the new QR code.");
    const ipWrap = h("label", "field", ipDet);
    h("span", "", ipWrap, "Device IP address");
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
  const prev = vis[pos - 1], next = vis[pos + 1];
  navRow(
    body,
    prev !== undefined ? { label: CREATE_STEPS[prev], go: () => go(prev) } : undefined,
    next !== undefined ? { label: `Next: ${CREATE_STEPS[next]}`, go: () => go(next) } : undefined,
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
