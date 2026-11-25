// Copy bundled presets into the site so the studio can cross-check them.
import { copyFileSync, mkdirSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = join(root, "components", "alarm_sound_detector", "presets");
const dst = join(root, "web", "public", "presets");
mkdirSync(dst, { recursive: true });
for (const f of readdirSync(src)) {
  if (!f.endsWith(".json")) continue;
  copyFileSync(join(src, f), join(dst, f));
  console.log("copied", f);
}

// App documentation, published next to the site so in-app links stay on the
// same origin (github.com blob pages are unreachable from some networks and
// unreliable in embedded webviews): /docs/*.md (+ /agent-guide.md at the root
// for agents) and /examples/*.yaml. Links between published docs stay relative;
// links to other repo files become absolute GitHub blob URLs; images resolve to
// raw.githubusercontent.com so they render anywhere.
{
  const { readFileSync, writeFileSync } = await import("fs");
  const REPO = "https://github.com/gl0wa/esphome-alarm-sound-detector";
  const RAW = "https://raw.githubusercontent.com/gl0wa/esphome-alarm-sound-detector/main/";
  const blobBase = `${REPO}/blob/main/docs/`;
  const SITE_PATH = {
    "wiring.md": "docs/wiring.md",
    "preset_parameters.md": "docs/preset_parameters.md",
    "preset_authoring.md": "docs/preset_authoring.md",
    "home_assistant.md": "docs/home_assistant.md",
    "agent_guide.md": "agent-guide.md", // published at the site root (dash, not underscore)
  };
  // Rewrites relative markdown links for a copy published at `atRoot`
  // (/agent-guide.md) or under /docs/.
  const rewrite = (md, atRoot) => md.replace(/(!?)\]\((?!https?:|#|mailto:)([^)]+)\)/g,
    (m, bang, p) => {
      const hash = p.indexOf("#");
      const path = hash < 0 ? p : p.slice(0, hash);
      const frag = hash < 0 ? "" : p.slice(hash);
      const base = path.split("/").pop();
      if (base in SITE_PATH) {
        const dest = SITE_PATH[base];
        const url = atRoot ? `./${dest}`
          : dest.startsWith("docs/") ? `./${dest.slice("docs/".length)}` : `../${dest}`;
        return `${bang}](${url}${frag})`;
      }
      if (path.startsWith("../assets/")) {
        const rest = path.slice("../assets/".length);
        return atRoot
          ? `${bang}](https://gl0wa.github.io/esphome-alarm-sound-detector/docs/assets/${rest}${frag})`
          : `${bang}](./assets/${rest}${frag})`;
      }
      if (bang) return `${bang}](${new URL(path, RAW).href}${frag})`;
      return `](${new URL(path, blobBase).href}${frag})`;
    });
  const docsDst = join(root, "web", "public", "docs");
  mkdirSync(join(docsDst, "assets"), { recursive: true });
  for (const f of ["wiring.md", "preset_parameters.md", "preset_authoring.md", "home_assistant.md"]) {
    const md = readFileSync(join(root, "docs", f), "utf8");
    writeFileSync(join(docsDst, f), rewrite(md, false));
    console.log("copied docs/" + f + " -> public/docs/" + f);
  }
  const guide = readFileSync(join(root, "docs", "agent_guide.md"), "utf8");
  writeFileSync(join(root, "web", "public", "agent-guide.md"), rewrite(guide, true));
  console.log("copied agent_guide.md -> public/agent-guide.md");
  copyFileSync(join(root, "assets", "wiring.svg"), join(docsDst, "assets", "wiring.svg"));
  console.log("copied assets/wiring.svg -> public/docs/assets/wiring.svg");
  const exDst = join(root, "web", "public", "examples");
  mkdirSync(exDst, { recursive: true });
  for (const f of readdirSync(join(root, "examples"))) {
    if (!f.endsWith(".yaml")) continue;
    copyFileSync(join(root, "examples", f), join(exDst, f));
    console.log("copied examples/" + f);
  }
}
