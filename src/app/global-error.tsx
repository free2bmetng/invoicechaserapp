"use client";

import "./globals.css";

// Replaces the root layout when it fails, so it brings its own document and
// styles. Theme follows the OS colour scheme via the tokens in globals.css.
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = error instanceof Error && "digest" in error && typeof error.digest === "string" ? error.digest : null;
  return (
    <html lang="en">
      <head>
        <title>Something went wrong · Invoice Chaser</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body
        className="min-h-dvh bg-bg text-ink antialiased"
        style={{ fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif" }}
      >
        <main className="flex min-h-dvh items-center justify-center px-4 py-16">
          <div className="w-full max-w-md text-center">
            <p className="text-small font-semibold text-ink-2">Invoice Chaser</p>
            <h1 className="mt-6 text-page-title text-ink">Invoice Chaser didn&apos;t load</h1>
            <p role="alert" className="mx-auto mt-3 max-w-sm text-body text-ink-2">
              Something went wrong on our side. Trying again usually fixes it. Your reminders keep running as
              scheduled.
            </p>
            <div className="mt-7 flex flex-col-reverse items-stretch justify-center gap-2 sm:flex-row sm:items-center">
              {/* A full page load, since the app's own layout is what failed. */}
              <a
                href="/"
                className="inline-flex h-11 items-center justify-center rounded-[10px] border border-line-strong bg-surface px-4 text-[14px] font-medium text-ink hover:bg-surface-2 sm:h-10"
              >
                Go to dashboard
              </a>
              <button
                type="button"
                onClick={() => retry()}
                className="inline-flex h-11 items-center justify-center rounded-[10px] bg-accent px-4 text-[14px] font-medium text-accent-ink hover:bg-accent-hover sm:h-10"
              >
                Try again
              </button>
            </div>
            {digest ? (
              <p className="mt-8 text-small text-ink-3">
                If it keeps happening, contact support and quote <span className="font-mono text-ink-2">{digest}</span>.
              </p>
            ) : null}
          </div>
        </main>
      </body>
    </html>
  );
}
