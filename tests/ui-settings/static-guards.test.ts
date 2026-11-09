// Source-level guards for the settings and onboarding screens. They enforce rules that a runtime test
// cannot see: design tokens only, no modal pop-ups, no delivery claims, and server action exports.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else if (/\.(tsx?|css)$/.test(entry)) out.push(path);
  }
  return out;
}

const UI_FILES = [
  ...filesUnder(join(ROOT, "src", "components", "settings")),
  join(ROOT, "src", "components", "copy-button.tsx"),
  ...filesUnder(join(ROOT, "src", "app", "(app)", "settings")),
  ...filesUnder(join(ROOT, "src", "app", "(app)", "onboarding")),
];

const SERVER_FILES = [
  join(ROOT, "src", "app", "actions", "settings.ts"),
  join(ROOT, "src", "app", "actions", "account.ts"),
  join(ROOT, "src", "app", "api", "export", "route.ts"),
  join(ROOT, "src", "lib", "queries", "settings.ts"),
  join(ROOT, "src", "lib", "account.ts"),
];

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function lines(path: string): Array<{ text: string; line: number }> {
  return read(path)
    .split("\n")
    .map((text, index) => ({ text, line: index + 1 }));
}

describe("design rules", () => {
  it("uses design tokens only: no raw hex colours in any settings or onboarding file", () => {
    const hex = /#[0-9a-fA-F]{3,8}\b/;
    const offenders = UI_FILES.flatMap((file) =>
      lines(file)
        .filter(({ text }) => hex.test(text) && !text.trim().startsWith("//"))
        .map(({ text, line }) => `${relative(ROOT, file)}:${line} ${text.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it("opens no modal and uses no native dialog", () => {
    const pattern = /<dialog|showModal|role="dialog"|aria-modal|window\.alert|window\.confirm|window\.prompt/;
    const offenders = UI_FILES.flatMap((file) =>
      lines(file)
        .filter(({ text }) => pattern.test(text))
        .map(({ text, line }) => `${relative(ROOT, file)}:${line} ${text.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it("never claims a message reached an inbox", () => {
    const pattern = /delivered to (the )?inbox|reached (the )?inbox|in your inbox|landed in (the )?inbox/i;
    const offenders = [...UI_FILES, ...SERVER_FILES].flatMap((file) =>
      lines(file)
        .filter(({ text }) => pattern.test(text))
        .map(({ text, line }) => `${relative(ROOT, file)}:${line} ${text.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it("asks for no review and nags about nothing", () => {
    const pattern = /leave a review|rate us|review us|rate your experience|upgrade|upsell|subscribe now/i;
    const offenders = UI_FILES.flatMap((file) =>
      lines(file)
        .filter(({ text }) => pattern.test(text))
        .map(({ text, line }) => `${relative(ROOT, file)}:${line} ${text.trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe("server boundaries", () => {
  it("marks both action files as server modules and exports only async functions from them", () => {
    for (const file of [join(ROOT, "src", "app", "actions", "settings.ts"), join(ROOT, "src", "app", "actions", "account.ts")]) {
      const source = read(file);
      expect(source.trimStart().startsWith('"use server"')).toBe(true);
      const exports = source.split("\n").filter((line) => /^export\s/.test(line));
      expect(exports.length).toBeGreaterThan(0);
      for (const line of exports) {
        expect(line).toMatch(/^export (async function|type |interface )/);
      }
    }
  });

  it("keeps the Stripe key out of every client component and every log line that names it", () => {
    for (const file of UI_FILES) {
      expect(read(file)).not.toMatch(/console\.(log|error)\([^)]*stripeKey/);
    }
  });

  it("writes no settings from a client-supplied user id", () => {
    const source = read(join(ROOT, "src", "app", "actions", "settings.ts"));
    expect(source).not.toMatch(/field\(formData,\s*"user_?[iI]d"\)/);
    expect(source).not.toMatch(/formData\.get\("user_?[iI]d"\)/);
  });
});
