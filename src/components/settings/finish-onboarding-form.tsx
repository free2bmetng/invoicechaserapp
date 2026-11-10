"use client";

// Finish setup: the highlighted last row of the checklist, shown once steps 1, 2 and 4 are done.
// The server checks the same steps again, so a stale page cannot finish setup early.
import { finishOnboardingAction } from "@/app/actions/settings";
import { Button } from "@/components/ui";
import { StatusLine, useSettingsForm } from "./form-kit";

export function FinishOnboardingForm() {
  const form = useSettingsForm(finishOnboardingAction);

  return (
    <form ref={form.formRef} onSubmit={form.onSubmit} noValidate className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full bg-accent text-accent-ink">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
            <path d="M6 21V4m0 0h10l-2 4 2 4H6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <div className="min-w-0">
          <p className="text-body font-semibold text-ink">
            <span className="sr-only">Next: </span>Finish setup
          </p>
          <p className="mt-0.5 text-small text-ink-2">Plans the reminders for every open invoice. You can run it again safely.</p>
          <StatusLine state={form.state} className="mt-1" />
        </div>
      </div>
      <Button type="submit" variant="primary" disabled={form.pending} aria-busy={form.pending || undefined} className="max-sm:w-full">
        {form.pending ? "Finishing…" : "Finish setup"}
      </Button>
    </form>
  );
}
