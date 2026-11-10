"use client";

import { startTransition, useActionState, useEffect, useRef, useState, type FormEvent } from "react";
import { usePasskeySupport } from "@/components/passkey/add-passkey";
import { Button, buttonClass, cx, TextInput } from "@/components/ui";
import { requestLoginLink, type LoginState } from "./actions";
import { PasskeySignIn } from "./passkey-sign-in";

const IDLE: LoginState = { status: "idle" };
const RESEND_AFTER_SECONDS = 30;
const SIGN_IN_SUBJECT = "Your Invoice Chaser sign-in link";

// Sign-in screen. A passkey is the primary way in where the browser supports one; the email link is
// the secondary way, for a new device or a lost phone. Submission goes through our own handler (not a
// bare <form action>), so React does not reset the form: an error keeps the typed address, keeps the
// passkey option on screen, and moves focus to the email field, which the error describes.
export function LoginForm({ notice }: { notice: string | null }) {
  const [state, formAction, pending] = useActionState(requestLoginLink, IDLE);
  const [email, setEmail] = useState("");
  const [dismissed, setDismissed] = useState<LoginState | null>(null);
  const passkeySupported = usePasskeySupport();

  // After a refusal, focus the email field. The error is its description, so it is read out with it.
  useEffect(() => {
    if (state.status === "error") document.getElementById("login-email")?.focus();
  }, [state]);

  function submit(formData: FormData) {
    startTransition(() => formAction(formData));
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submit(new FormData(event.currentTarget));
  }

  if (state.status === "sent" && dismissed !== state) {
    return (
      <SentPanel
        state={state}
        pending={pending}
        onResend={() => {
          const data = new FormData();
          data.set("email", state.email);
          submit(data);
        }}
        onUseAnother={() => setDismissed(state)}
      />
    );
  }

  return (
    <SignInView
      state={state}
      email={email}
      onEmailChange={setEmail}
      notice={notice}
      pending={pending}
      passkeySupported={passkeySupported}
      formAction={formAction}
      onSubmit={onSubmit}
    />
  );
}

// The form itself, with no hooks of its own, so a test can render each state directly.
export function SignInView({
  state,
  email,
  onEmailChange,
  notice,
  pending,
  passkeySupported,
  formAction,
  onSubmit,
}: {
  state: LoginState;
  email: string;
  onEmailChange: (value: string) => void;
  notice: string | null;
  pending: boolean;
  passkeySupported: boolean;
  formAction?: (formData: FormData) => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const error = state.status === "error" ? state.message : null;
  return (
    <div className="flex flex-col gap-7">
      <div>
        <h1 className="text-page-title text-ink">Sign in</h1>
        <p className="mt-1.5 text-body text-ink-2">Welcome back. There&apos;s no password to remember.</p>
      </div>

      {notice && !error ? (
        <p role="alert" className="rounded-[var(--radius-md)] border border-warn/30 bg-warn-soft px-4 py-3 text-body text-ink">
          {notice}
        </p>
      ) : null}

      {passkeySupported ? (
        <div className="flex flex-col gap-6">
          <PasskeySignIn />
          <div className="flex items-center gap-3 text-small text-ink-3" aria-hidden="true">
            <span className="h-px flex-1 bg-line" />
            or use your email
            <span className="h-px flex-1 bg-line" />
          </div>
        </div>
      ) : null}

      {/* `action` keeps the form working before JavaScript loads; onSubmit takes over once it has. */}
      <form action={formAction} onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="login-email" className="text-small font-medium text-ink">
            Email address
          </label>
          <TextInput
            id="login-email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            width="full"
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "login-email-error" : undefined}
            placeholder="you@yourbusiness.com"
            readOnly={pending}
            value={email}
            onChange={(e) => onEmailChange(e.target.value)}
          />
          {error ? (
            <p id="login-email-error" role="alert" className="text-small font-medium text-danger">
              {error}
            </p>
          ) : null}
        </div>
        <Button
          type="submit"
          variant={passkeySupported ? "secondary" : "primary"}
          className="w-full"
          aria-busy={pending || undefined}
          disabled={pending}
        >
          {pending ? "Sending link…" : "Email me a sign-in link"}
        </Button>
        <p className="text-small text-ink-3">Each link works once and expires after 15 minutes.</p>
      </form>
    </div>
  );
}

// Where to open the mail app. Consumer Microsoft addresses use outlook.live.com; everything else that
// might be Outlook is a work account on outlook.office.com.
export function mailLinks(email: string): { gmail: string; outlook: string } {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  const consumerMicrosoft = /^(outlook|hotmail|live|msn)\./.test(domain);
  const search = encodeURIComponent(`in:anywhere subject:"${SIGN_IN_SUBJECT}"`);
  return {
    gmail: `https://mail.google.com/mail/u/0/#search/${search}`,
    outlook: consumerMicrosoft ? "https://outlook.live.com/mail/0/" : "https://outlook.office.com/mail/",
  };
}

function useCountdown(seconds: number, restartKey: unknown): number {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    setLeft(seconds);
    const timer = window.setInterval(() => setLeft((value) => (value > 0 ? value - 1 : 0)), 1000);
    return () => window.clearInterval(timer);
  }, [seconds, restartKey]);
  return left;
}

export function SentPanel({
  state,
  pending,
  onResend,
  onUseAnother,
}: {
  state: Extract<LoginState, { status: "sent" }>;
  pending: boolean;
  onResend: () => void;
  onUseAnother: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const left = useCountdown(RESEND_AFTER_SECONDS, state);
  const links = mailLinks(state.email);

  // The form has gone, so move focus to the new heading.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div className="flex flex-col gap-7">
      <div>
        <span aria-hidden="true" className="mb-5 grid size-11 place-items-center rounded-[12px] border border-line bg-surface-2 text-ink-2">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <rect x="3.5" y="5.5" width="17" height="13" rx="2.2" stroke="currentColor" strokeWidth="1.7" />
            <path d="m4.5 7 7.5 6 7.5-6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <h1 ref={headingRef} tabIndex={-1} className="text-page-title text-ink focus:outline-none">
          Check your email
        </h1>
        <p role="status" className="mt-1.5 text-body text-ink-2">
          We sent a sign-in link to <span className="font-medium break-words text-ink">{state.email}</span>. It works once
          and expires in 15 minutes.
        </p>
      </div>

      {state.sendingOff ? (
        state.devLink ? (
          <DevelopmentLink href={state.devLink} />
        ) : (
          <p className="text-body text-ink-2">Email sending is off on this installation, so nothing was emailed.</p>
        )
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <a href={links.gmail} target="_blank" rel="noopener noreferrer" className={cx(buttonClass("secondary"), "w-full")}>
            Open Gmail
          </a>
          <a href={links.outlook} target="_blank" rel="noopener noreferrer" className={cx(buttonClass("secondary"), "w-full")}>
            Open Outlook
          </a>
        </div>
      )}

      <div className="flex flex-col gap-1 border-t border-line pt-5">
        <p className="text-small text-ink-2">Didn&apos;t get it? Check your spam folder first.</p>
        <div className="-ml-3 flex flex-wrap items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            onClick={onResend}
            disabled={left > 0 || pending}
            aria-busy={pending || undefined}
          >
            {pending ? "Sending…" : left > 0 ? `Resend in 0:${String(left).padStart(2, "0")}` : "Resend the link"}
          </Button>
          <Button type="button" variant="ghost" onClick={onUseAnother}>
            Use a different email
          </Button>
        </div>
      </div>
    </div>
  );
}

// Only ever rendered in development, where email sending is off. The server returns devLink in no
// other environment.
function DevelopmentLink({ href }: { href: string }) {
  return (
    <section aria-labelledby="dev-link-title" className="rounded-[var(--radius-md)] border border-warn/30 bg-warn-soft p-4">
      <p id="dev-link-title" className="text-small font-semibold text-warn">
        Development sign-in link
      </p>
      <p className="mt-1 text-small text-ink-2">Email sending is off here, so nothing was emailed. This is never shown in production.</p>
      <a href={href} className={cx(buttonClass("primary"), "mt-3 w-full")}>
        Open sign-in link
      </a>
      <p className="mt-2 font-mono text-[12px] break-all text-ink-3">{href}</p>
    </section>
  );
}
