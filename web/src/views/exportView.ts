// Step 5: export the preset (JSON + YAML + labels), session save/restore.
import { buildPresetDoc, personalPresetDoc, PresetMeta, validatePreset } from "../preset";
import { button, download, field, h, note, textArea } from "../helpers";
import { clearSession, State, storageUsed } from "../store";
import { REPO_URL, SITE_DOCS_URL, SITE_URL } from "../help";
import { DeviceSettings, buildDeviceYaml, getRoute, loadDeviceSettings, safeId } from "../device";
import { renderDeviceCard } from "./deviceCard";

type ExportTab = "install" | "github";
let tab: ExportTab = "install";

export function renderExport(root: HTMLElement, s: State, refresh: () => void, devIn?: DeviceSettings) {
  const dev: DeviceSettings = devIn ?? loadDeviceSettings();
  root.innerHTML = "";
  if (!s.template) {
    note(root, "Build the detector first.");
    return;
  }
  const m = s.meta;
  const nameRow = h("div", "grid", root);
  const fAppl = field(nameRow, "What is it? (used for the Home Assistant entity names)", m.name, {
    onChange: (v) => { m.name = v.trim(); refreshYaml(); },
  });
  fAppl.placeholder = "e.g. Rice cooker";
  fAppl.addEventListener("input", () => { m.name = fAppl.value.trim(); refreshYaml(); });
  let refreshYaml = () => { /* set by the install tab */ };

  // Full preset details (only needed for sharing) live in the GitHub tab.
  const detailsBox = h("div", "", root);
  detailsBox.remove();
  h("h3", "", detailsBox, "Preset details");
  const g = h("div", "grid", detailsBox);
  const fId = field(g, "preset id (snake_case)", m.id, { onChange: (v) => { m.id = v; check(); } });
  const fName = fAppl;
  const fMan = field(g, "manufacturer", m.manufacturer, { onChange: (v) => { m.manufacturer = v; check(); } });
  const fMod = field(g, "model", m.model, { onChange: (v) => { m.model = v; check(); } });
  const fSnd = field(g, "sound", m.sound, { onChange: (v) => { m.sound = v; check(); } });

  const fAl = field(g, "aliases (comma separated)", m.aliases, { onChange: (v) => { m.aliases = v; } });
  const fTest = field(g, "tested against (comma separated)", m.testedAgainst, { onChange: (v) => { m.testedAgainst = v; } });
  const fVal = field(g, "validation", m.validation, { onChange: (v) => { m.validation = v; check(); } });
  const fDesc = textArea(g, "description", m.description, { rows: 3, onChange: (v) => { m.description = v; } });
  const fNotes = textArea(g, "notes", m.notes, { rows: 3, onChange: (v) => { m.notes = v; } });
  void [fName, fMan, fMod, fSnd, fDesc, fAl, fTest, fVal, fNotes];
  const ph: [HTMLInputElement | HTMLTextAreaElement, string][] = [
    [fId, "e.g. bosch_serie6_dishwasher_end"],
    [fMan, "e.g. Bosch"], [fMod, "e.g. SMS6ECI03E"], [fSnd, "e.g. end-of-programme melody"],
    [fDesc, "What the sound is and when the appliance plays it (e.g. “three-tone melody at the end of every programme, repeats every minute until the door is opened”)"], [fAl, "optional"],
    [fTest, "e.g. speech, TM6 chime, microwave beep"], [fVal, "e.g. one household, volume high"], [fNotes, "Optional: anything a reviewer or user should know (volume setting used, microphone distance, known look-alike sounds)"],
  ];
  for (const [inp, text] of ph) inp.placeholder = text;
  for (const inp of [fId, fMan, fMod, fSnd, fDesc, fAl, fTest, fVal, fNotes]) inp.addEventListener("input", () => check());

  const status = h("p", "note", detailsBox, "");
  const meta: () => PresetMeta = () => ({
    id: fId.value.trim(), name: fName.value.trim(), manufacturer: fMan.value.trim(),
    model: fMod.value.trim(), sound: fSnd.value.trim(), description: fDesc.value.trim(),
    aliases: fAl.value.split(",").map((x) => x.trim()).filter(Boolean),
    testedAgainst: fTest.value, validation: fVal.value.trim(), notes: fNotes.value.trim(),
  });
  const docOf = () => buildPresetDoc(meta(), s.template!, s.band, s.params, s.examples.length);
  const personalDoc = () => personalPresetDoc(meta(), s.template!, s.band, s.params, s.examples.length);
  function check() {
    const v = validatePreset(docOf());
    const mm = meta();
    const missing = ([["preset id", mm.id], ["name (above)", mm.name], ["manufacturer", mm.manufacturer],
      ["model", mm.model], ["sound", mm.sound], ["validation", mm.validation]] as [string, string][])
      .filter(([, val]) => !val).map(([k]) => k);
    if (v.ok) { status.textContent = "✓ Ready to share: the preset is valid."; status.className = "ok"; }
    else if (missing.length) { status.textContent = `Still needed: ${missing.join(", ")}.`; status.className = "warn"; }
    else { status.textContent = `Please fix: ${v.errors.join("; ")}`; status.className = "warn"; }
  }
  check();

  const id = () => meta().id || safeId(`${meta().name || "my_appliance"}_alarm`);
  const downloadPreset = (): boolean => {
    const doc = docOf();
    const v = validatePreset(doc);
    if (!v.ok) { alert(`Fix the preset details first: ${v.errors.join("; ")}`); return false; }
    download(`${id()}.json`, JSON.stringify(doc, null, 1) + "\n");
    return true;
  };

  const tabs = h("div", "subtabs", root);
  const body = h("div", "", root);
  const tabBtn = (t: ExportTab, label: string) => {
    const b = button(tabs, label, () => { tab = t; renderTab(); }, "subtab");
    return b;
  };
  const tInstall = tabBtn("install", "Install on your device");
  const tGh = tabBtn("github", "Share it on GitHub");

  function renderTab() {
    tInstall.classList.toggle("active", tab === "install");
    tGh.classList.toggle("active", tab === "github");
    body.innerHTML = "";
    if (tab === "install") renderInstall();
    else renderGithub();
  }

  function renderInstall() {
    const fromDevice = getRoute() === "device";
    renderDeviceCard(body, dev, () => renderTab());
    const pre = document.createElement("pre");
    pre.className = "snippet";
    let yaml = "";
    refreshYaml = () => {
      const doc = personalDoc();
      const label = meta().name || "My appliance";
      yaml = buildDeviceYaml(dev, [{ id: safeId(label), ref: null, doc, label }], false);
      pre.textContent = yaml;
    };
    refreshYaml();
    const row = h("div", "row", body);
    button(row, "Copy YAML", async () => {
      try { await navigator.clipboard.writeText(yaml); copyMsg.textContent = "Copied."; }
      catch { copyMsg.textContent = "Copy failed; open “Show the YAML” and select the text."; }
    }, "primary");
    button(row, "Download YAML", () => download(`${dev.deviceName}.yaml`, yaml));
    const copyMsg = h("span", "muted", row, "");
    copyMsg.setAttribute("role", "status");
    const ol = h("ol", "steps-list", body);
    h("li", "", ol, fromDevice
      ? "In the ESPHome dashboard, replace the device's YAML with this one (this removes the recording firmware — sound stays on the device again)."
      : "In the ESPHome dashboard: New device → paste this YAML.");
    h("li", "", ol, "Make sure ESPHome's secrets contain wifi_ssid and wifi_password.");
    h("li", "", ol, fromDevice ? "Install (over Wi-Fi)." : "Install (the first install is over USB, later ones over Wi-Fi).");
    h("li", "", ol, "Add the device in Home Assistant. Test it with the real appliance and watch the match score for the first days.");
    const yd = h("details", "", body);
    h("summary", "", yd, "Show the YAML");
    yd.appendChild(pre);
    const hand = h("p", "note", body, "Maintaining your YAML by hand? ");
    button(hand, "Download preset JSON", () => {
      download(`${id()}.json`, JSON.stringify(personalDoc(), null, 1) + "\n");
    });
    h("span", "", hand, " and use ");
    h("code", "", hand, `template: ${id()}.json`);
    h("span", "", hand, " — see the ");
    const ex = h("a", "", hand, "example configuration") as HTMLAnchorElement;
    ex.href = `${SITE_URL}/examples/stamp-s3-inmp441-thermomix-tm6.yaml`; ex.target = "_blank"; ex.rel = "noopener";
    h("span", "", hand, " and ");
    const wi = h("a", "", hand, "wiring") as HTMLAnchorElement;
    wi.href = `${SITE_DOCS_URL}/wiring.md`; wi.target = "_blank"; wi.rel = "noopener";
    h("span", "", hand, ".");
  }

  function renderGithub() {
    note(body, "Sharing adds your preset to the catalog so other owners of the same appliance can use it with one line of YAML. " +
      "Only the preset file is shared — it contains an averaged fingerprint, never audio. Never attach recordings.");
    body.appendChild(detailsBox);
    check();
    const ol = h("ol", "steps-list", body);
    h("li", "", ol, "Fill in the preset details above: manufacturer, model, which sound, what you tested it against " +
      "(other appliances, speech, kitchen noise) and how it was validated (e.g. “one household, volume 3”).");
    const li2 = h("li", "", ol, "Download the preset file: ");
    button(li2, "Download preset JSON", () => { downloadPreset(); }, "primary");
    const li3 = h("li", "", ol, "Upload it on GitHub — GitHub creates a copy of the repository for you and offers to open a pull request: ");
    const up = h("a", "", li3, "open the upload page") as HTMLAnchorElement;
    up.href = `${REPO_URL}/upload/main/components/alarm_sound_detector/presets`;
    up.target = "_blank"; up.rel = "noopener";
    const li4 = h("li", "", ol, "Paste this description into the pull request: ");
    const prText = () => [
      `## New preset: ${meta().name || id()}`,
      "",
      `- Appliance: ${meta().manufacturer} ${meta().model}`,
      `- Sound: ${meta().sound}`,
      `- Examples used: ${s.examples.length}`,
      `- Pattern: ${s.params.period_s ? `repeats every ${s.params.period_s} s` : "single sound"}`,
      `- Band: ${s.band.loHz}–${s.band.hiHz} Hz, threshold ${s.params.threshold}`,
      s.margin ? `- Margin (weakest example − loudest background): ${s.margin.margin.toFixed(2)}` : "- Margin: not measured",
      `- Tested against: ${meta().testedAgainst || "(please describe)"}`,
      `- Validation: ${meta().validation || "(please describe)"}`,
      "",
      "Made with the preset studio. No audio attached.",
    ].join("\n");
    const msg = h("span", "muted", li4, "");
    button(li4, "Copy description", async () => {
      try { await navigator.clipboard.writeText(prText()); msg.textContent = " Copied."; } catch { msg.textContent = " Copy failed."; }
    });
    h("li", "", ol, "A maintainer reviews it, regenerates the catalog index and merges it. Thanks!");
    h("pre", "snippet", body, prText());
    const alt = h("p", "note", body, "Not comfortable with pull requests? ");
    const issue = h("a", "", alt, "Open an issue instead") as HTMLAnchorElement;
    issue.href = `${REPO_URL}/issues/new?title=${encodeURIComponent(`Preset: ${meta().manufacturer} ${meta().model} – ${meta().sound}`.trim())}` +
      `&body=${encodeURIComponent(prText() + "\n\n(Attach the preset JSON file to this issue — not any recordings.)")}`;
    issue.target = "_blank"; issue.rel = "noopener";
    h("span", "", alt, " and attach the preset JSON file.");
    const lab = h("p", "note", body, "Optional for reviewers: ");
    button(lab, "Download labels JSON", () => {
      download(`${id()}.labels.json`, JSON.stringify({
        preset: meta().id,
        examples: s.examples.map((e) => {
          const r = s.recordings.find((x) => x.id === e.recId);
          return { file: r?.name ?? e.recId, t0: +e.t0.toFixed(2), t1: +e.t1.toFixed(2) };
        }),
        recordings: s.recordings.map((r) => r.name),
        band_hz: [s.band.loHz, s.band.hiHz],
        duration_s: s.duration,
        detection: s.params,
      }, null, 1) + "\n");
    });
    h("span", "", lab, " (file names and time stamps of your examples, no audio; check that file names reveal nothing private).");
  }
  renderTab();

  const sess = h("details", "", root);
  h("summary", "", sess, "Your saved session");
  note(sess, "Your recordings, examples and settings are saved automatically in this browser and offered " +
    "again when you come back. Nothing is uploaded. Clearing browser data for this site removes them.");
  const srow = h("div", "row", sess);
  const smsg = h("span", "muted", srow, "");
  void storageUsed().then((u) => { if (u) smsg.textContent = `Browser storage used by this site: ${u}.`; });
  button(srow, "Delete saved session", async () => {
    if (!confirm("Delete the saved recordings and labels from this browser? The current page keeps working until you reload.")) return;
    await clearSession();
    smsg.textContent = "Deleted from this browser.";
  });
}
