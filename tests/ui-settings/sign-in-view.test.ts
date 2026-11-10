// The sign-in screen's states, rendered directly. An email error must keep the passkey option on
// screen and keep the typed address, and the error must describe the field. After sending, the
// screen offers Open Gmail, Open Outlook and a resend timer.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { mailLinks, SentPanel, SignInView } from "@/app/(auth)/login/login-form";
import type { LoginState } from "@/app/(auth)/login/actions";

const noop = () => {};

function view(state: LoginState, options: { email?: string; passkeySupported?: boolean; notice?: string | null } = {}) {
  return renderToStaticMarkup(
    createElement(SignInView, {
      state,
      email: options.email ?? "",
      onEmailChange: noop,
      notice: options.notice ?? null,
      pending: false,
      passkeySupported: options.passkeySupported ?? true,
    }),
  );
}

describe("the sign-in form", () => {
  it("makes the passkey the primary button and the email link secondary", () => {
    const html = view({ status: "idle" });
    expect(html).toContain("Sign in with a passkey");
    const passkeyButton = html.match(/<button[^>]*>(?:(?!<\/button>).)*Sign in with a passkey/)?.[0] ?? "";
    expect(passkeyButton).toContain("bg-accent");
    const emailButton = html.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? "";
    expect(emailButton).toContain("border-line-strong");
    expect(emailButton).not.toContain("bg-accent ");
  });

  it("keeps the passkey option and the typed address after an error, and ties the error to the field", () => {
    const html = view({ status: "error", message: "Enter a valid email address, such as name@company.com." }, { email: "maya@studio" });
    expect(html).toContain("Sign in with a passkey");
    expect(html).toMatch(/<input[^>]*id="login-email"[^>]*value="maya@studio"/);
    expect(html).toMatch(/<input[^>]*aria-invalid="true"/);
    expect(html).toMatch(/<input[^>]*aria-describedby="login-email-error"/);
    expect(html).toMatch(/id="login-email-error" role="alert"[^>]*>Enter a valid email address/);
  });

  it("keeps the passkey option after a rate-limit error too", () => {
    const html = view({ status: "error", message: "Too many sign-in links were requested." }, { email: "maya@okafor.test" });
    expect(html).toContain("Sign in with a passkey");
    expect(html).toContain('value="maya@okafor.test"');
  });

  it("makes the email link the primary button where passkeys are not supported", () => {
    const html = view({ status: "idle" }, { passkeySupported: false });
    expect(html).not.toContain("Sign in with a passkey");
    expect(html.match(/<button[^>]*type="submit"[^>]*>/)?.[0]).toContain("bg-accent");
  });

  it("shows an expired-link notice, but lets an error replace it", () => {
    const notice = "This sign-in link has expired or was already used. Request a new one below.";
    expect(view({ status: "idle" }, { notice })).toContain(notice);
    expect(view({ status: "error", message: "Enter your email address." }, { notice })).not.toContain(notice);
  });
});

describe("after the link is sent", () => {
  function sent(state: Extract<LoginState, { status: "sent" }>) {
    return renderToStaticMarkup(createElement(SentPanel, { state, pending: false, onResend: noop, onUseAnother: noop }));
  }

  it("offers Open Gmail and Open Outlook, and a resend timer", () => {
    const html = sent({ status: "sent", email: "maya@okafor.test", sendingOff: false });
    expect(html).toContain("maya@okafor.test");
    expect(html).toMatch(/<a[^>]*href="https:\/\/mail\.google\.com\/[^"]*"[^>]*target="_blank"[^>]*>Open Gmail<\/a>/);
    expect(html).toMatch(/<a[^>]*href="https:\/\/outlook\.office\.com\/mail\/"[^>]*>Open Outlook<\/a>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Resend in 0:30<\/button>/);
    expect(html).toContain("Use a different email");
  });

  it("shows the development link instead of mail buttons when sending is off", () => {
    const html = sent({ status: "sent", email: "maya@okafor.test", sendingOff: true, devLink: "http://localhost:3000/auth/verify?token=x" });
    expect(html).toContain("Open sign-in link");
    expect(html).not.toContain("Open Gmail");
  });

  it("opens consumer Outlook for Microsoft consumer addresses", () => {
    expect(mailLinks("maya@hotmail.co.uk").outlook).toBe("https://outlook.live.com/mail/0/");
    expect(mailLinks("maya@outlook.com").outlook).toBe("https://outlook.live.com/mail/0/");
    expect(mailLinks("maya@okafor.test").outlook).toBe("https://outlook.office.com/mail/");
    expect(decodeURIComponent(mailLinks("maya@gmail.com").gmail)).toContain('subject:"Your Invoice Chaser sign-in link"');
  });
});
