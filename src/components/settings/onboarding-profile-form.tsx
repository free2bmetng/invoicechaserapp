"use client";

// Onboarding step 1: the sender details and the settings that have defaults, saved together.
// The fields are the same components the settings cards use.
import { useState } from "react";
import { saveOnboardingProfileAction } from "@/app/actions/settings";
import { DailyCapField, DigestFields, SendWindowFields, SenderFields, TimezoneField, type SenderValues } from "./fields";
import { SaveBar, useSettingsForm } from "./form-kit";

export interface OnboardingProfileValues extends SenderValues {
  timezone: string;
  windowStart: string;
  windowEnd: string;
  dailyCap: string;
  digestEnabled: boolean;
  digestHour: string;
}

export function OnboardingProfileForm({ initial }: { initial: OnboardingProfileValues }) {
  const form = useSettingsForm(saveOnboardingProfileAction);
  const [values, setValues] = useState<OnboardingProfileValues>(initial);
  const errors = form.state.fieldErrors;

  function patch(next: Partial<OnboardingProfileValues>) {
    setValues((previous) => ({ ...previous, ...next }));
  }

  return (
    <form ref={form.formRef} onSubmit={form.onSubmit} noValidate className="flex flex-col gap-6">
      <div className="flex flex-col gap-5">
        <SenderFields values={values} onChange={patch} errors={errors} />
      </div>

      <div className="flex flex-col gap-5 border-t border-line pt-6">
        <TimezoneField value={values.timezone} onChange={(zone) => patch({ timezone: zone })} error={errors.timezone} />
        <SendWindowFields
          start={values.windowStart}
          end={values.windowEnd}
          onStartChange={(hour) => patch({ windowStart: hour })}
          onEndChange={(hour) => patch({ windowEnd: hour })}
          errors={errors}
        />
        <p className="text-[13px] leading-5 text-ink-3">
          Invoice Chaser only sends between 09:00 and 17:00, so you can narrow this window but not widen it.
        </p>
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

      <SaveBar pending={form.pending} state={form.state} idleLabel="Save and continue" pendingLabel="Saving…" />
    </form>
  );
}
