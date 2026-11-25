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
