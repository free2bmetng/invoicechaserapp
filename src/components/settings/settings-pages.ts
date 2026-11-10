// The settings sub-pages, in tab order. Pure data and functions, so the tabs, the pages and the
// tests all read the same list. /settings itself is the first sub-page, so old links keep working.
export type SettingsPageKey = "profile" | "sending-domain" | "sign-in" | "payments" | "terms" | "account";

export interface SettingsPage {
  key: SettingsPageKey;
  label: string;
  href: string;
}

export const SETTINGS_PAGES: readonly SettingsPage[] = [
  { key: "profile", label: "Profile and sending window", href: "/settings" },
  { key: "sending-domain", label: "Sending domain", href: "/settings/sending-domain" },
  { key: "sign-in", label: "Sign-in", href: "/settings/sign-in" },
  { key: "payments", label: "Payments", href: "/settings/payments" },
  { key: "terms", label: "Terms", href: "/settings/terms" },
  { key: "account", label: "Account", href: "/settings/account" },
];

// The tab a path belongs to. Unknown paths under /settings fall back to the first tab.
export function activeSettingsPage(pathname: string | null | undefined): SettingsPageKey {
  const path = (pathname ?? "/settings").replace(/\/+$/, "") || "/";
  const match = SETTINGS_PAGES.find((page) => page.href !== "/settings" && (path === page.href || path.startsWith(`${page.href}/`)));
  return match?.key ?? "profile";
}

// Before the sub-pages, settings was one long page with section anchors. A bookmarked
// /settings#sending-domain should still land on the right sub-page.
const LEGACY_ANCHORS: Record<string, SettingsPageKey> = {
  sender: "profile",
  "sender-details": "profile",
  timezone: "profile",
  "send-window": "profile",
  "daily-limit": "profile",
  digest: "profile",
  sending: "sending-domain",
  "sending-domain": "sending-domain",
  "sign-in": "sign-in",
  passkeys: "sign-in",
  payments: "payments",
  stripe: "payments",
  terms: "terms",
  "late-terms": "terms",
  account: "account",
  "your-data": "account",
  "delete-account": "account",
};

// The sub-page path for an old anchor, or null when the anchor is unknown or already on page one.
export function legacySettingsTarget(hash: string): string | null {
  const key = LEGACY_ANCHORS[hash.replace(/^#/, "")];
  if (!key || key === "profile") return null;
  return SETTINGS_PAGES.find((page) => page.key === key)?.href ?? null;
}
