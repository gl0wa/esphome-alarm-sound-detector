// Step 5: export the preset (JSON + YAML + labels), session save/restore.
import { buildPresetDoc, buildYamlSnippet, PresetMeta, validatePreset } from "../preset";
import { button, download, field, h, note } from "../helpers";
import { clearSession, loadSession, saveSession, State } from "../store";

export function renderExport(root: HTMLElement, s: State, refresh: () => void) {
  root.innerHTML = "";
  h("h2", "", root, "5 · Export");
  note(root, "Only the averaged, quantised template leaves this page — never your audio. " +
    "The JSON is validated against the preset schema before download.");

  if (!s.template) {
    note(root, "Build a template in step 3 first.");
    return;
  }
  h("h3", "", root, "Preset details");
  const g = h("div", "grid", root);
  const m = s.meta;
  const fId = field(g, "preset id (snake_case)", m.id, { onChange: (v) => { m.id = v; check(); } });
  const fName = field(g, "display name", m.name, { onChange: (v) => { m.name = v; } });
  const fMan = field(g, "manufacturer", m.manufacturer, { onChange: (v) => { m.manufacturer = v; check(); } });
  const fMod = field(g, "model", m.model, { onChange: (v) => { m.model = v; check(); } });
  const fSnd = field(g, "sound", m.sound, { onChange: (v) => { m.sound = v; check(); } });
  const fDesc = field(g, "description", m.description, { onChange: (v) => { m.description = v; } });
  const fAl = field(g, "aliases (comma separated)", m.aliases, { onChange: (v) => { m.aliases = v; } });
  const fTest = field(g, "tested against (comma separated)", m.testedAgainst, { onChange: (v) => { m.testedAgainst = v; } });
  const fVal = field(g, "validation", m.validation, { onChange: (v) => { m.validation = v; check(); } });
  const fNotes = field(g, "notes", m.notes, { onChange: (v) => { m.notes = v; } });
  void [fName, fMan, fMod, fSnd, fDesc, fAl, fTest, fVal, fNotes];

  const status = h("p", "note", root, "");
  const meta: () => PresetMeta = () => ({
    id: fId.value.trim(), name: fName.value.trim(), manufacturer: fMan.value.trim(),
    model: fMod.value.trim(), sound: fSnd.value.trim(), description: fDesc.value.trim(),
    aliases: fAl.value.split(",").map((x) => x.trim()).filter(Boolean),
    testedAgainst: fTest.value, validation: fVal.value.trim(), notes: fNotes.value.trim(),
  });
  const docOf = () => buildPresetDoc(meta(), s.template!, s.band, s.params, s.examples.length);
  function check() {
    const v = validatePreset(docOf());
    status.textContent = v.ok ? "✓ Valid against preset.schema.json." : `Invalid: ${v.errors.join("; ")}`;
    status.className = v.ok ? "ok" : "warn";
  }
  check();

  const row = h("div", "row", root);
  button(row, "Download preset JSON", () => {
    const doc = docOf();
    const v = validatePreset(doc);
    if (!v.ok) { alert(`Fix validation first: ${v.errors.join("; ")}`); return; }
    download(`${meta().id || "preset"}.json`, JSON.stringify(doc, null, 1) + "\n");
  });
  button(row, "Download ESPHome YAML", () => {
    const id = meta().id || "preset";
    download(`${id}.yaml`, buildYamlSnippet(id, `${id}.json`));
  });
  button(row, "Copy ESPHome YAML", async () => {
    await navigator.clipboard.writeText(buildYamlSnippet(meta().id || "preset", `${meta().id || "preset"}.json`));
    status.textContent = "YAML snippet copied to clipboard.";
  });
  button(row, "Download labels JSON", () => {
    download(`${meta().id || "preset"}.labels.json`, JSON.stringify({
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
  note(root, "To use it: put the JSON next to your ESPHome YAML, paste the snippet, and install. " +
    "To contribute it upstream, open a PR adding the JSON (plus docs) — never attach household audio.");

  h("h3", "", root, "Session (this browser only)");
  const srow = h("div", "row", root);
  const smsg = h("span", "muted", srow, "");
  button(srow, "Save session", async () => { await saveSession(s); smsg.textContent = "Saved in this browser (IndexedDB)."; });
  button(srow, "Restore session", async () => { smsg.textContent = await loadSession(s); refresh(); });
  button(srow, "Forget saved session", async () => { await clearSession(); smsg.textContent = "Cleared."; });
}
