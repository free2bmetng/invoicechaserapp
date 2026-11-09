"use client";

// The Sender section: sender details, timezone, send window, daily limit and digest. Each keeps its own
// card and its own fields, but the section has one form and one Save at its end. That Save checks every
// field first, so a refused field saves nothing.
import { useState } from "react";
import { saveSenderSettingsAction } from "@/app/actions/settings";
import { DailyCapField, DigestFields, SendWindowFields, SenderFields, TimezoneField } from "./fields";
import { SaveBar, SettingsCard, useSettingsForm } from "./form-kit";
import type { OnboardingProfileValues } from "./onboarding-profile-form";
import { FOOTER_LINES, isSenderProfileComplete } from "@/lib/templates";

export function SenderSettingsForm({ initial }: { initial: OnboardingProfileValues }) {
  const form = useSettingsForm(saveSenderSettingsAction);
  const [values, setValues] = useState<OnboardingProfileValues>(initial);
  const errors = form.state.fieldErrors;
  const complete = isSenderProfileComplete(values);

  function patch(next: Partial<OnboardingProfileValues>) {
    setValues((previous) => ({ ...previous, ...next }));
  }

  return (
    <form ref={form.formRef} onSubmit={form.onSubmit} noValidate className="flex flex-col gap-5">
      <SettingsCard
        id="sender-details"
        level={3}
        title="Sender details"
        description={
          <p>
            Every reminder ends with a footer built from these three fields. You cannot remove the footer. Reminders stay
            off until all three are filled in.
          </p>
        }
      >
        <div className="flex flex-col gap-5">
          <SenderFields values={values} onChange={patch} errors={errors} />

          <div className="rounded-[var(--radius-md)] border border-line bg-surface-2 p-4">
            <p className="text-[12px] font-semibold tracking-[0.1em] text-ink-3 uppercase">Footer on every reminder</p>
            {complete ? (
              <pre className="mt-2.5 font-mono text-[13px] leading-6 break-words whitespace-pre-wrap text-ink">
                {FOOTER_LINES(values)}
              </pre>
            ) : (
              <p className="mt-2.5 text-[14px] leading-6 text-ink-2">
                The footer appears here once all three fields are filled in. Until then, no reminder can be created or
                sent.
              </p>
            )}
            <p className="mt-2.5 text-[13px] leading-5 text-ink-3">
              Invoice Chaser adds this footer to every client email. You cannot edit or remove it.
            </p>
          </div>
        </div>
      </SettingsCard>

      <div className="grid gap-5 lg:grid-cols-2">
        <SettingsCard
          id="timezone"
          level={3}
          title="Timezone"
          description={
            <p>
              Send windows and digest times use this timezone. A client with its own timezone is reminded in that zone
              instead.
            </p>
          }
        >
          <TimezoneField value={values.timezone} onChange={(zone) => patch({ timezone: zone })} error={errors.timezone} />
        </SettingsCard>

        <SettingsCard
          id="send-window"
          level={3}
          title="Send window"
          description={
            <p>
              Invoice Chaser only sends between 09:00 and 17:00, so reminders never go out early or late. You can narrow
              this window, but not widen it. Times are in the client&apos;s timezone, or yours when a client has none.
            </p>
          }
        >
          <SendWindowFields
            start={values.windowStart}
            end={values.windowEnd}
            onStartChange={(hour) => patch({ windowStart: hour })}
            onEndChange={(hour) => patch({ windowEnd: hour })}
            errors={errors}
          />
        </SettingsCard>

        <SettingsCard
          id="daily-limit"
          level={3}
          title="Daily reminder limit"
          description={<p>The most client reminders Invoice Chaser sends for you on one local day.</p>}
        >
          <DailyCapField value={values.dailyCap} onChange={(cap) => patch({ dailyCap: cap })} error={errors.dailyCap} />
        </SettingsCard>

        <SettingsCard
          id="digest"
          level={3}
          title="Daily digest"
          description={<p>A summary email to your sign-in address, at the hour you choose.</p>}
        >
          <DigestFields
            enabled={values.digestEnabled}
            onEnabledChange={(on) => patch({ digestEnabled: on })}
            hour={values.digestHour}
            onHourChange={(hour) => patch({ digestHour: hour })}
            timezone={values.timezone}
            error={errors.digestHour}
          />
        </SettingsCard>
      </div>

      <SaveBar pending={form.pending} state={form.state} idleLabel="Save sender settings" pendingLabel="Saving…" />
    </form>
  );
}
