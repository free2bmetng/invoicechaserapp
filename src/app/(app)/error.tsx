"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { Button, StatePanel, buttonClass } from "@/components/ui";

// Error boundary for every signed-in page. The shell (sidebar, menu) stays in
// place, so the user can also navigate away from here.
export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const digest = error instanceof Error && "digest" in error && typeof error.digest === "string" ? error.digest : null;

  useEffect(() => {
    console.error(error);
    heading.current?.focus();
  }, [error]);

  return (
    <>
      <title>Something went wrong · Invoice Chaser</title>
      <StatePanel
        tone="danger"
        title="This page didn't load"
        headingRef={heading}
        body={
          <p role="alert">
            Something went wrong on our side. Trying again usually fixes it. Your reminders keep running as scheduled.
          </p>
        }
        actions={
          <>
            <Link href="/" className={buttonClass("secondary")}>
              Go to dashboard
            </Link>
            <Button variant="primary" onClick={() => retry()}>
              Try again
            </Button>
          </>
        }
        detail={
          digest ? (
            <p>
              If it keeps happening, contact support and quote <span className="num font-mono text-ink-2">{digest}</span>.
            </p>
          ) : null
        }
      />
    </>
  );
}
