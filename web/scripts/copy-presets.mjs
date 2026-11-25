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

// The agent guide, published next to the site (relative links → GitHub URLs) so
// agents without a clone can read it: /agent-guide.md (+ /llms.txt points to it).
{
  const { readFileSync, writeFileSync } = await import("fs");
  const blob = "https://github.com/gl0wa/esphome-alarm-sound-detector/blob/main/docs/";
  const md = readFileSync(join(root, "docs", "agent_guide.md"), "utf8")
    .replace(/\]\((?!https?:|#|mailto:)([^)]+)\)/g, (_, p) => `](${new URL(p, blob).href})`);
  writeFileSync(join(root, "web", "public", "agent-guide.md"), md);
  console.log("copied agent_guide.md -> public/agent-guide.md");
}
