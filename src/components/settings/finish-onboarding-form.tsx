"use client";

// Finish setup. The button stays disabled until steps 1, 2 and 4 are done (spec 3.8). The server
// checks the same thing again, so a stale page cannot finish setup early.
import { finishOnboardingAction } from "@/app/actions/settings";
import { Button } from "@/components/ui";
import { readableDisabled, SettingsCard, StatusLine, useSettingsForm } from "./form-kit";

// "A", "A and B", "A, B and C": one readable sentence fragment.
function listed(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function FinishOnboardingForm({ missing }: { missing: string[] }) {
  const form = useSettingsForm(finishOnboardingAction);
  const ready = missing.length === 0;

  return (
    <SettingsCard
      id="finish"
      title="Finish setup"
      description={
        <p>
          Finishing plans the reminders for every open invoice. Nothing is planned before then, and finishing can be
          repeated safely.
        </p>
      }
    >
      <form ref={form.formRef} onSubmit={form.onSubmit} noValidate className="flex flex-col gap-4 border-t border-line pt-5">
        {!ready ? (
          <p id="finish-missing" className="text-[14px] leading-6 font-medium text-ink">
            Finish needs: {listed(missing)}.
          </p>
        ) : null}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <StatusLine state={form.state} />
          <Button
            type="submit"
            variant="primary"
            disabled={!ready || form.pending}
            aria-describedby={ready ? undefined : "finish-missing"}
            aria-busy={form.pending || undefined}
            className={`w-full sm:ml-auto sm:w-auto ${readableDisabled}`}
          >
            {form.pending ? "Finishing…" : "Finish setup"}
          </Button>
        </div>
      </form>
    </SettingsCard>
  );
}
