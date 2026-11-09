"use server";

// Public entry point: anyone can ask for a sign-in link, so this only validates the
// address and hands it to requestMagicLink, which applies the rate limit. It never
// reveals whether an address already has an account.
import { AuthNotConfiguredError, InvalidEmailError, LoginRateLimitedError, requestMagicLink } from "@/lib/auth";
import { systemClock } from "@/lib/clock";

export type LoginState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "sent"; email: string; sendingOff: boolean; devLink?: string };

const EMAIL_MAX_LENGTH = 254;

export async function requestLoginLink(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const raw = formData.get("email");
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!email) return { status: "error", message: "Enter your email address." };
  if (email.length > EMAIL_MAX_LENGTH) return { status: "error", message: "Enter a valid email address, such as name@company.com." };

  try {
    const { devLink } = await requestMagicLink(email, systemClock);
    // Only a development environment ever gets a link back. Production never shows one.
    const showDevLink = devLink !== undefined && process.env.NODE_ENV !== "production";
    return {
      status: "sent",
      email,
      sendingOff: devLink !== undefined,
      devLink: showDevLink ? devLink : undefined,
    };
  } catch (err) {
    if (err instanceof InvalidEmailError) {
      return { status: "error", message: "Enter a valid email address, such as name@company.com." };
    }
    if (err instanceof LoginRateLimitedError) {
      return { status: "error", message: err.message };
    }
    if (err instanceof AuthNotConfiguredError) {
      return { status: "error", message: "Sign-in email is not set up yet. Check the sending settings, then try again." };
    }
    console.error("Sign-in link request failed:", err instanceof Error ? err.name : "unknown error");
    return { status: "error", message: "We could not send a sign-in link. Try again in a moment." };
  }
}
