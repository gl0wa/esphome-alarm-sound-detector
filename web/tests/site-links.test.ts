// In-app links must point to working locations: documentation and examples stay
// on the published site (same origin as the app), because github.com blob pages
// are unreachable from some networks and unreliable in embedded webviews. Only
// links that inherently need GitHub (upload page, new-issue page, repo footer)
// may target github.com.
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { HELP, REPO_URL, SITE_DOCS_URL, SITE_URL } from "../src/help";

const REPO = join(__dirname, "..", "..");
const SRC = join(REPO, "web", "src");
const CLI = join(REPO, "web", "cli");
const PUBLIC = join(REPO, "web", "public");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    if (f.isDirectory()) out.push(...tsFiles(p));
    else if (f.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** All URLs the app can open: literal https://… plus `${CONST}/…` templates. */
function appUrls(): string[] {
  const urls = new Set<string>();
  for (const f of [...tsFiles(SRC), ...tsFiles(CLI)]) {
    const s = readFileSync(f, "utf8");
    for (const m of s.matchAll(/https?:\/\/[^\s"'`)\]}]+/g)) {
      urls.add(m[0].replace(/[.,;:]+$/, ""));
    }
    for (const m of s.matchAll(/\$\{(SITE_URL|SITE_DOCS_URL|REPO_URL)\}([^"'`]*)/g)) {
      const base = { SITE_URL, SITE_DOCS_URL, REPO_URL }[m[1] as "SITE_URL"];
      urls.add(base + m[2]);
    }
  }
  return [...urls].filter((u) => !u.includes("${") && !u.includes("<"));
}

const GITHUB_ACTIONS = ["/upload/", "/issues/new"];
const isSiteUrl = (u: string) => u === SITE_URL || u.startsWith(SITE_URL + "/");

describe("in-app links", () => {
  it("no longer points at github.com blob pages", () => {
    expect([...appUrls()].filter((u) => u.includes("github.com") && u.includes("/blob/"))).toEqual([]);
  });

  it("github.com links are only ones that need GitHub", () => {
    for (const u of appUrls().filter((u) => u.includes("github.com"))) {
      expect(
        u === REPO_URL || GITHUB_ACTIONS.some((a) => u.includes(a)),
        `${u} should be self-hosted on the site or removed`,
      ).toBe(true);
    }
  });

  it("every same-site link has a published file", () => {
    const missing: string[] = [];
    for (const u of appUrls().filter(isSiteUrl)) {
      const rel = new URL(u).pathname.replace(/^\/esphome-alarm-sound-detector\/?/, "");
      if (rel === "" || rel === "cli/asd.mjs") continue; // built index.html / CLI bundle
      if (!existsSync(join(PUBLIC, rel))) missing.push(`${u} -> web/public/${rel}`);
    }
    expect(missing).toEqual([]);
  });

  it("published docs keep working relative links", () => {
    const missing: string[] = [];
    const check = (base: string, file: string) => {
      const md = readFileSync(join(base, file), "utf8");
      for (const m of md.matchAll(/(!?)\]\((?!https?:|#|mailto:)([^)]+)\)/g)) {
        const target = m[2].split("#")[0];
        if (!existsSync(join(base, target))) missing.push(`${file}: ${m[2]}`);
      }
    };
    const docsDir = join(PUBLIC, "docs");
    for (const f of readdirSync(docsDir)) {
      if (f.endsWith(".md")) check(docsDir, f);
    }
    check(PUBLIC, "agent-guide.md");
    expect(missing).toEqual([]);
  });

  it("every help (?) anchor exists in the published doc", () => {
    const slug = (h: string) =>
      h.toLowerCase().replace(/[^a-z0-9 _-]/g, "").trim().replace(/ +/g, "-");
    const headings = new Set(
      readFileSync(join(REPO, "docs", "preset_parameters.md"), "utf8")
        .split("\n").filter((l) => l.startsWith("#")).map((l) => slug(l.replace(/^#+/, ""))),
    );
    for (const [key, e] of Object.entries(HELP)) {
      expect(headings.has(e.anchor), `help "${key}" -> missing section #${e.anchor}`).toBe(true);
    }
  });
});
