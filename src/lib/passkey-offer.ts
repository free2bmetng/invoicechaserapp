// Cookies for the add-a-passkey offer. Plain values only, so the server and the client can both import them.
//
// A magic-link sign-in sets PASSKEY_OFFER_COOKIE for an hour. The shell then shows the offer until the
// user dismisses it, which sets PASSKEY_DISMISSED_COOKIE for a year. Passkey sign-in sets neither.
export const PASSKEY_OFFER_COOKIE = "ic_passkey_offer";
export const PASSKEY_DISMISSED_COOKIE = "ic_passkey_dismissed";

const HOUR_SECONDS = 60 * 60;

export const PASSKEY_OFFER_MAX_AGE_SECONDS = HOUR_SECONDS;
export const PASSKEY_DISMISSED_MAX_AGE_SECONDS = 365 * 24 * HOUR_SECONDS;

export const PASSKEY_OFFER_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: PASSKEY_OFFER_MAX_AGE_SECONDS,
};

// The offer is shown once a magic-link sign-in has raised it, and only until the user has dismissed it.
export function passkeyOfferVisible(offer: string | undefined, dismissed: string | undefined): boolean {
  return offer === "1" && dismissed !== "1";
}
