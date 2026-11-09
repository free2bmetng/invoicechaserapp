"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button, Field, TextInput } from "@/components/ui";
import { requestLoginLink, type LoginState } from "./actions";
import { PasskeySignIn } from "./passkey-sign-in";

const IDLE: LoginState = { status: "idle" };

// Sign-in screen. A passkey comes first where the browser supports one. The email link is the
// fallback, and it is the way in on a new device or after a lost phone. After a request it shows
// "check your email" instead, and offers a way back to the form without a full page load.
export function LoginForm({ notice }: { notice: string | null }) {
  const [state, formAction, pending] = useActionState(requestLoginLink, IDLE);
  const [dismissed, setDismissed] = useState<LoginState | null>(null);

  if (state.status === "sent" && dismissed !== state) {
    return <SentPanel state={state} onUseAnother={() => setDismissed(state)} />;
  }

  const error = state.status === "error" ? state.message : null;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[24px] leading-8 font-semibold tracking-[-0.02em] text-ink">Sign in</h1>
        <p className="mt-2 text-[15px] leading-6 text-ink-2">There is no password to remember.</p>
      </div>

      {notice && state.status === "idle" ? (
        <p role="alert" className="rounded-[12px] border border-warn/25 bg-warn-soft px-4 py-3 text-[14px] leading-6 text-warn">
          {notice}
        </p>
      ) : null}

      {state.status === "idle" ? <PasskeySignIn /> : null}

      <form action={formAction} noValidate className="flex flex-col gap-5">
        <Field id="login-email" label="Email address" error={error ?? undefined} hint="Use the address you invoice from.">
          <TextInput
            id="login-email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            placeholder="you@yourbusiness.com"
            disabled={pending}
          />
        </Field>
        <Button type="submit" variant="primary" className="w-full" disabled={pending}>
          {pending ? "Sending link…" : "Email me a sign-in link"}
        </Button>
        <p className="text-[13px] leading-5 text-ink-3">
          For a new device or a lost phone. Each link works once and expires after 15 minutes.
        </p>
      </form>
    </div>
  );
}

function SentPanel({ state, onUseAnother }: { state: Extract<LoginState, { status: "sent" }>; onUseAnother: () => void }) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  // The form has gone, so move focus to the new heading.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 ref={headingRef} tabIndex={-1} className="text-[24px] leading-8 font-semibold tracking-[-0.02em] text-ink focus:outline-none">
          Check your email
        </h1>
        <p role="status" className="mt-2 text-[15px] leading-6 text-ink-2">
          We sent a sign-in link to <span className="font-medium break-words text-ink">{state.email}</span>. It works once and
          expires in 15 minutes.
        </p>
      </div>

      {state.sendingOff ? (
        <p className="text-[14px] leading-6 text-ink-2">
          Email sending is off in this environment, so nothing was emailed. Use the development link below.
        </p>
      ) : (
        <p className="text-[14px] leading-6 text-ink-2">Didn’t get it? Check your spam folder, then try again.</p>
      )}

      {state.devLink ? <DevelopmentLink href={state.devLink} /> : null}

      <div>
        <Button type="button" variant="secondary" onClick={onUseAnother}>
          Use a different email
        </Button>
      </div>
    </div>
  );
}

// Only ever rendered in development. The server returns devLink in no other environment.
function DevelopmentLink({ href }: { href: string }) {
  return (
    <section aria-labelledby="dev-link-title" className="rounded-[12px] border border-warn/30 bg-warn-soft p-4">
      <p id="dev-link-title" className="text-[13px] font-semibold text-warn">
        Development sign-in link
      </p>
      <p className="mt-1 text-[13px] leading-5 text-ink-2">
        Shown only in development, because email sending is off. It is never shown in production.
      </p>
      <a
        href={href}
        className="mt-3 inline-flex h-10 items-center justify-center rounded-[10px] bg-accent px-4 text-sm font-medium text-accent-ink no-underline hover:bg-accent-hover"
      >
        Open sign-in link
      </a>
      <p className="mt-2 font-mono text-[12px] break-all text-ink-3">{href}</p>
    </section>
  );
}
