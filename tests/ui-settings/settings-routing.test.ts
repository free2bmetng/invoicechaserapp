// Settings is split into sub-pages. These pin the routing: which tab a path belongs to, that every
// tab has a page, that /settings itself still works (as the first sub-page), and that old
// single-page anchors still lead somewhere sensible.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activeSettingsPage, legacySettingsTarget, SETTINGS_PAGES } from "@/components/settings/settings-pages";

const APP = join(__dirname, "..", "..", "src", "app", "(app)", "settings");

function pageFileFor(href: string): string {
  const rest = href.replace(/^\/settings\/?/, "");
  return join(APP, ...(rest ? rest.split("/") : []), "page.tsx");
}

describe("settings sub-pages", () => {
  it("lists the six sub-pages in order, with /settings as the first", () => {
    expect(SETTINGS_PAGES.map((page) => page.label)).toEqual([
      "Profile and sending window",
      "Sending domain",
      "Sign-in",
      "Payments",
      "Terms",
      "Account",
    ]);
    expect(SETTINGS_PAGES[0].href).toBe("/settings");
  });

  it("has a page file and a browser tab title for every sub-page, and one shared layout", () => {
    expect(existsSync(join(APP, "layout.tsx"))).toBe(true);
    for (const page of SETTINGS_PAGES) {
      const file = pageFileFor(page.href);
      expect(existsSync(file), `${page.href} -> ${file}`).toBe(true);
      expect(readFileSync(file, "utf8")).toMatch(/export const metadata: Metadata = \{ title: "[^"]+" \}/);
    }
  });

  it("marks the tab that owns the current path", () => {
    expect(activeSettingsPage("/settings")).toBe("profile");
    expect(activeSettingsPage("/settings/")).toBe("profile");
    expect(activeSettingsPage("/settings/sending-domain")).toBe("sending-domain");
    expect(activeSettingsPage("/settings/sign-in")).toBe("sign-in");
    expect(activeSettingsPage("/settings/payments/")).toBe("payments");
    expect(activeSettingsPage("/settings/terms")).toBe("terms");
    expect(activeSettingsPage("/settings/account")).toBe("account");
    // An unknown or missing path falls back to the first tab rather than marking none.
    expect(activeSettingsPage("/settings/nothing-here")).toBe("profile");
    expect(activeSettingsPage(null)).toBe("profile");
  });

  it("forwards the old single-page anchors to their sub-page", () => {
    expect(legacySettingsTarget("#sending-domain")).toBe("/settings/sending-domain");
    expect(legacySettingsTarget("#sending")).toBe("/settings/sending-domain");
    expect(legacySettingsTarget("#passkeys")).toBe("/settings/sign-in");
    expect(legacySettingsTarget("#stripe")).toBe("/settings/payments");
    expect(legacySettingsTarget("late-terms")).toBe("/settings/terms");
    expect(legacySettingsTarget("#delete-account")).toBe("/settings/account");
    // Anchors on the first sub-page, and unknown anchors, stay where they are.
    expect(legacySettingsTarget("#sender")).toBeNull();
    expect(legacySettingsTarget("#digest")).toBeNull();
    expect(legacySettingsTarget("#unknown")).toBeNull();
  });

  it("sends the Stripe Connect return on /settings to the Payments page", () => {
    const source = readFileSync(pageFileFor("/settings"), "utf8");
    expect(source).toMatch(/redirect\(`\/settings\/payments\?\$\{query\.toString\(\)\}`\)/);
  });

  it("never shows a setting's environment variable name to customers", () => {
    const files = [
      ...SETTINGS_PAGES.map((page) => pageFileFor(page.href)),
      join(__dirname, "..", "..", "src", "components", "settings", "stripe-card.tsx"),
      join(__dirname, "..", "..", "src", "components", "settings", "sending-domain-form.tsx"),
    ];
    for (const file of files) {
      // JSX text and string literals only: comments may name the variable for developers.
      const visible = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
      expect(visible, file).not.toMatch(/STRIPE_CONNECT_CLIENT_ID|STRIPE_KEY_MODE|APP_URL|SEND_ENABLED/);
    }
  });
});
