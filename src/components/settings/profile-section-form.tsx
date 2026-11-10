"use client";

// The edit form inside one of the profile page's EditableSections. The save action checks the whole
// sender section at once, so each form also sends the other sections' current values as hidden
// fields. Only the open section changes. The form closes itself after a successful save.
import { useEffect, useState } from "react";
import { saveSenderSettingsAction } from "@/app/actions/settings";
import { useEditableSection } from "@/components/data";
import { DailyCapField, DigestFields, SendWindowFields, SenderFields, TimezoneField } from "./fields";
import { FooterLines } from "./footer-preview";
import { FormActions, useSettingsForm } from "./form-kit";
import type { ProfileValues } from "./profile-values";

export type ProfileSection = "sender" | "schedule" | "digest";

const FIELDS_BY_SECTION: Record<ProfileSection, ReadonlyArray<keyof ProfileValues>> = {
  sender: ["senderName", "businessName", "postalAddress"],
  schedule: ["timezone", "windowStart", "windowEnd", "dailyCap"],
  digest: ["digestEnabled", "digestHour"],
};

export function ProfileSectionForm({ section, current }: { section: ProfileSection; current: ProfileValues }) {
  const form = useSettingsForm(saveSenderSettingsAction);
  const editable = useEditableSection();
  const [values, setValues] = useState<ProfileValues>(current);
  const errors = form.state.fieldErrors;

  useEffect(() => {
    if (form.state.status === "saved") editable?.close();
  }, [form.state, editable]);

  function patch(next: Partial<ProfileValues>) {
    setValues((previous) => ({ ...previous, ...next }));
  }

  const own = new Set(FIELDS_BY_SECTION[section]);
  // The other sections' saved values, so this save leaves them as they are.
  const hidden = (Object.keys(current) as Array<keyof ProfileValues>).filter((key) => !own.has(key));
  // An error on a field this section does not show (a stale value) is reported in the status line.
  const message =
    form.state.status === "error" && Object.keys(errors).some((key) => !own.has(key as keyof ProfileValues))
      ? { ...form.state, message: "Another section has a value that needs checking. Reload the page and try again." }
      : form.state;

  return (
    <form ref={form.formRef} onSubmit={form.onSubmit} noValidate className="flex flex-col gap-5">
      {hidden.map((key) =>
        key === "digestEnabled" ? (
          current.digestEnabled ? <input key={key} type="hidden" name="digestEnabled" value="on" /> : null
        ) : (
          <input key={key} type="hidden" name={key} value={String(current[key])} />
        ),
      )}

      {section === "sender" ? (
        <>
          <SenderFields values={values} onChange={patch} errors={errors} />
          <div className="max-w-md rounded-[var(--radius-md)] border border-line bg-surface-2 px-3 py-2.5">
            <p className="mb-1.5 text-small text-ink-3">Footer on every reminder</p>
            <FooterLines values={values} />
          </div>
        </>
      ) : null}

      {section === "schedule" ? (
        <>
          <TimezoneField value={values.timezone} onChange={(zone) => patch({ timezone: zone })} error={errors.timezone} />
          <div className="flex flex-col gap-1.5">
            <SendWindowFields
              start={values.windowStart}
              end={values.windowEnd}
              onStartChange={(hour) => patch({ windowStart: hour })}
              onEndChange={(hour) => patch({ windowEnd: hour })}
              errors={errors}
            />
            <p className="max-w-md text-small text-ink-3">
              Reminders only go out between 09:00 and 17:00. You can narrow this window, not widen it.
            </p>
          </div>
          <DailyCapField value={values.dailyCap} onChange={(cap) => patch({ dailyCap: cap })} error={errors.dailyCap} />
        </>
      ) : null}

      {section === "digest" ? (
        <DigestFields
          enabled={values.digestEnabled}
          onEnabledChange={(on) => patch({ digestEnabled: on })}
          hour={values.digestHour}
          onHourChange={(hour) => patch({ digestHour: hour })}
          timezone={values.timezone}
          error={errors.digestHour}
        />
      ) : null}

      <FormActions pending={form.pending} state={message} idleLabel="Save" pendingLabel="Saving…" />
    </form>
  );
}
