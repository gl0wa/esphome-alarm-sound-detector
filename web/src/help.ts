// Short in-page explanations; each links to the detailed section in
// docs/preset_parameters.md on GitHub.
export const REPO_URL = "https://github.com/gl0wa/esphome-alarm-sound-detector";
export const DOCS_URL = `${REPO_URL}/blob/main/docs/preset_parameters.md`;

export interface HelpEntry { text: string; anchor: string }

export const HELP: Record<string, HelpEntry> = {
  band: {
    anchor: "frequency-band",
    text: "Which pitches the detector listens to. Pick the range where your sound is clearly louder than the background; everything outside is ignored. Narrower is usually more robust.",
  },
  duration: {
    anchor: "sound-length",
    text: "Length of the window the detector compares with the template, e.g. one beep or one chime phrase. It should cover the characteristic part of the sound with little silence around it.",
  },
  mode: {
    anchor: "repeating-or-single",
    text: "Repeating: the appliance repeats the sound at a steady rhythm until acknowledged (the detector checks the rhythm). Single: one occurrence is enough.",
  },
  threshold: {
    anchor: "threshold",
    text: "Match score (0–1) needed to count a repetition. Higher = fewer false alarms but more misses. Use “Suggest thresholds” to place it between your examples and the loudest background.",
  },
  near_threshold: {
    anchor: "near-threshold",
    text: "Scores between this and the threshold are reported as near misses (useful to spot sounds that almost triggered). Must be below the threshold.",
  },
  min_repetitions: {
    anchor: "minimum-repetitions",
    text: "How many matching repetitions are needed before the alarm turns on. 2 for repeating alarms (robust), 1 for single sounds (fast).",
  },
  period: {
    anchor: "period",
    text: "Time from the start of one repetition to the start of the next (seconds). Empty for single sounds.",
  },
  period_tolerance: {
    anchor: "period-tolerance",
    text: "How far (seconds) the spacing between repetitions may differ from the period and still count as the same alarm.",
  },
  refractory: {
    anchor: "refractory",
    text: "After a repetition is counted, ignore new matches for this long, so one sound is not counted twice. Keep it shorter than the period (for beeps 1 s apart about 0.6 s); “Estimate repetition” sets it for you.",
  },
  release: {
    anchor: "release",
    text: "The alarm turns off after this long without a repetition. For repeating alarms about 2 × period + 1 s.",
  },
  candidates: {
    anchor: "accepting-candidates",
    text: "Accept a candidate if the whole characteristic sound is inside the box, even if there is some silence around it. Reject it if it is a different sound or only a fragment.",
  },
};

/** Small “?” link: hover shows the short text, click opens the detailed docs. */
export function helpIcon(parent: HTMLElement, key: string): HTMLAnchorElement {
  const e = HELP[key];
  const a = document.createElement("a");
  a.className = "help";
  a.textContent = "?";
  a.href = `${DOCS_URL}#${e.anchor}`;
  a.target = "_blank";
  a.rel = "noopener";
  a.title = e.text;
  a.setAttribute("aria-label", `Help: ${e.text}`);
  parent.appendChild(a);
  return a;
}
