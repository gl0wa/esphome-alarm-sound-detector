# AGENTS.md

Instructions for AI coding agents (Codex, Claude Code, Gemini CLI, Cursor,
GitHub Copilot, Aider, Windsurf, Jules, …). Two kinds of tasks come here:

## 1. Helping a user set up an alarm detector for their appliance

Follow **[docs/agent_guide.md](docs/agent_guide.md)**. In short:

- Use the `asd` command-line tool (`web/dist/cli/asd.mjs` after `cd web && npm run build`,
  or download https://gl0wa.github.io/esphome-alarm-sound-detector/cli/asd.mjs — one
  file, Node.js 20+). It does everything the browser preset studio does: device
  YAML, recording from the device, finding the alarm in recordings, tuning,
  testing.
- Household audio stays on the user's machine: never upload recordings or send
  them (or descriptions derived from listening to them) to external services;
  never commit them. `device.json` and generated YAML contain keys — keep them
  private.
- Ask the user for physical actions (wiring, USB, playing the alarm) and before
  flashing devices or publishing anything. Report verified facts only.

## 2. Contributing to this repository

- Read `docs/PROJECT_STATE.md` first; update it when a milestone or decision changes.
- The repo is public: never commit secrets, private hostnames/IPs or household
  recordings (`data/`, `local/` and audio files are gitignored). Check
  `git diff --cached` before commits.
- Layout: `components/alarm_sound_detector/` (C++ core + ESPHome wrapper, presets),
  `components/capture_server/` (temporary recording firmware), `tools/` (Python
  reference implementation and preset tools), `web/` (browser studio + `web/cli/`
  command-line tool, both built on `detector_core.cpp` compiled to WebAssembly).
- Tests: `pytest` (Python, C++ equivalence, presets), `cd web && npm test`
  (studio; needs Emscripten), `cd web && npm run build:cli && sh cli/smoke.sh`
  (command-line tool). Presets: `python tools/presets/validate.py`.
- Use the pinned ESPHome version (2026.11.0; `.venv/bin/esphome` in a dev checkout).
