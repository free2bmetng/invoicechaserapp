"use client";

// Onboarding step 1: the sender details and the settings that have defaults, saved together.
// A 560px form, with a live preview of a reminder and its footer beside it on desktop.
// The fields are the same components the settings page uses.
import { useState } from "react";
import { saveOnboardingProfileAction } from "@/app/actions/settings";
import { DailyCapField, DigestFields, SendWindowFields, SenderFields, TimezoneField } from "./fields";
import { FooterLines, ReminderPreview } from "./footer-preview";
import { FormActions, useSettingsForm } from "./form-kit";
import type { ProfileValues } from "./profile-values";

export function OnboardingProfileForm({ initial, domain }: { initial: ProfileValues; domain: string | null }) {
  const form = useSettingsForm(saveOnboardingProfileAction);
  const [values, setValues] = useState<ProfileValues>(initial);
  const errors = form.state.fieldErrors;

  function patch(next: Partial<ProfileValues>) {
    setValues((previous) => ({ ...previous, ...next }));
  }

  return (
    <div className="lg:grid lg:grid-cols-[minmax(0,35rem)_minmax(0,1fr)] lg:items-start lg:gap-12">
      <form ref={form.formRef} onSubmit={form.onSubmit} noValidate className="flex max-w-[35rem] flex-col gap-5">
        <SenderFields values={values} onChange={patch} errors={errors} />
        <div className="max-w-md rounded-[var(--radius-md)] border border-line bg-surface-2 px-3 py-2.5 lg:hidden">
          <p className="mb-1.5 text-small text-ink-3">Footer on every reminder</p>
          <FooterLines values={values} />
        </div>

        <div className="mt-3 flex flex-col gap-5 border-t border-line pt-6">
          <div>
            <h2 className="text-section-title text-ink">When reminders go out</h2>
            <p className="mt-1 text-small text-ink-3">These have sensible defaults. Reminders only go out between 09:00 and 17:00.</p>
          </div>
          <TimezoneField value={values.timezone} onChange={(zone) => patch({ timezone: zone })} error={errors.timezone} />
          <SendWindowFields
            start={values.windowStart}
            end={values.windowEnd}
            onStartChange={(hour) => patch({ windowStart: hour })}
            onEndChange={(hour) => patch({ windowEnd: hour })}
            errors={errors}
          />
          <DailyCapField value={values.dailyCap} onChange={(cap) => patch({ dailyCap: cap })} error={errors.dailyCap} />
          <DigestFields
            enabled={values.digestEnabled}
            onEnabledChange={(on) => patch({ digestEnabled: on })}
            hour={values.digestHour}
            onHourChange={(hour) => patch({ digestHour: hour })}
            timezone={values.timezone}
            error={errors.digestHour}
          />
        </div>

        <div className="border-t border-line pt-5">
          <FormActions pending={form.pending} state={form.state} idleLabel="Save and continue" pendingLabel="Saving…" cancel={false} />
        </div>
      </form>

      <aside aria-label="Reminder preview" className="hidden lg:sticky lg:top-8 lg:block">
        <ReminderPreview values={values} domain={domain} />
        <p className="mt-3 text-small text-ink-3">The footer is added to every reminder and can&apos;t be removed.</p>
      </aside>
    </div>
  );
}
