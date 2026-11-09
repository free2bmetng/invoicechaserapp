"use client";

// Field-level inputs for the schedule settings. Shared by the settings cards and by onboarding
// step 1, so the two screens cannot drift apart.
import { useEffect, useState } from "react";
import { Button, Select, TextInput, Textarea } from "@/components/ui";
import { Field, fieldProps } from "./form-kit";
import {
  BUSINESS_NAME_LIMIT,
  DAILY_CAP_DEFAULT,
  DAILY_CAP_MAX,
  DAILY_CAP_MIN,
  DIGEST_HOURS,
  DIGEST_HOUR_DEFAULT,
  END_HOURS,
  hourLabel,
  POSTAL_ADDRESS_LIMIT,
  SENDER_NAME_LIMIT,
  START_HOURS,
  timeZoneOptions,
} from "./rules";

export interface SenderValues {
  senderName: string;
  businessName: string;
  postalAddress: string;
}

// The three sender fields. Shared by the sender card and onboarding step 1.
export function SenderFields({
  values,
  onChange,
  errors,
}: {
  values: SenderValues;
  onChange: (patch: Partial<SenderValues>) => void;
  errors: Record<string, string>;
}) {
  return (
    <>
      <Field
        id="senderName"
        label="Your name"
        hint={`How clients see you in the From line, for example Ada Lovelace. Up to ${SENDER_NAME_LIMIT} characters.`}
        error={errors.senderName}
      >
        <TextInput
          {...fieldProps("senderName", { hasHint: true, error: errors.senderName })}
          name="senderName"
          autoComplete="name"
          aria-required="true"
          value={values.senderName}
          onChange={(e) => onChange({ senderName: e.target.value })}
        />
      </Field>

      <Field
        id="businessName"
        label="Business name"
        hint={`Shown in the footer, for example Ada Studio Ltd. Up to ${BUSINESS_NAME_LIMIT} characters.`}
        error={errors.businessName}
      >
        <TextInput
          {...fieldProps("businessName", { hasHint: true, error: errors.businessName })}
          name="businessName"
          autoComplete="organization"
          aria-required="true"
          value={values.businessName}
          onChange={(e) => onChange({ businessName: e.target.value })}
        />
      </Field>

      <Field
        id="postalAddress"
        label="Postal address"
        hint={`Put each line on its own line. Clients can write to this address. Up to ${POSTAL_ADDRESS_LIMIT} characters.`}
        error={errors.postalAddress}
      >
        <Textarea
          {...fieldProps("postalAddress", { hasHint: true, error: errors.postalAddress })}
          name="postalAddress"
          autoComplete="street-address"
          aria-required="true"
          rows={3}
          value={values.postalAddress}
          onChange={(e) => onChange({ postalAddress: e.target.value })}
        />
      </Field>
    </>
  );
}

const ZONE_OPTIONS = timeZoneOptions();
const DATALIST_ID = "timezone-options";

function deviceTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function TimezoneField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (zone: string) => void;
  error?: string;
}) {
  const [device, setDevice] = useState<string | null>(null);
  // Read after mount, so the server render and the first client render match.
  useEffect(() => setDevice(deviceTimeZone()), []);

  return (
    <>
      <Field
        id="timezone"
        label="Your timezone"
        hint="Start typing a city or region, such as Europe/London, then pick it from the list."
        error={error}
      >
        <div className="relative">
          <TextInput
            {...fieldProps("timezone", { hasHint: true, error })}
            name="timezone"
            list={DATALIST_ID}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-required="true"
            className="pr-9"
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
          {/* The same chevron as the other selects, so the list reads as a pick-from list. */}
          <svg
            aria-hidden="true"
            width="12"
            height="8"
            viewBox="0 0 12 8"
            className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-ink-3"
          >
            <path d="M1 1.5l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <datalist id={DATALIST_ID}>
          {ZONE_OPTIONS.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      </Field>

      {device && device !== value ? (
        <div className="flex flex-wrap items-center gap-3 text-[13.5px] text-ink-2">
          <span>This device is set to {device}.</span>
          <Button type="button" size="sm" variant="ghost" onClick={() => onChange(device)}>
            Use {device}
          </Button>
        </div>
      ) : null}
    </>
  );
}

export function SendWindowFields({
  start,
  end,
  onStartChange,
  onEndChange,
  errors,
}: {
  start: string;
  end: string;
  onStartChange: (hour: string) => void;
  onEndChange: (hour: string) => void;
  errors: Record<string, string>;
}) {
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <Field id="windowStart" label="Starts at" hint="Earliest hour a reminder can go out." error={errors.windowStart}>
        <Select
          {...fieldProps("windowStart", { hasHint: true, error: errors.windowStart })}
          name="windowStart"
          value={start}
          onChange={(e) => onStartChange(e.target.value)}
        >
          {START_HOURS.map((hour) => (
            <option key={hour} value={String(hour)}>
              {hourLabel(hour)}
            </option>
          ))}
        </Select>
      </Field>

      <Field id="windowEnd" label="Ends at" hint="No reminder goes out at or after this hour." error={errors.windowEnd}>
        <Select
          {...fieldProps("windowEnd", { hasHint: true, error: errors.windowEnd })}
          name="windowEnd"
          value={end}
          onChange={(e) => onEndChange(e.target.value)}
        >
          {END_HOURS.map((hour) => (
            <option key={hour} value={String(hour)}>
              {hourLabel(hour)}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

export function DailyCapField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  return (
    <Field
      id="dailyCap"
      label="Reminders per day"
      hint={`A whole number from ${DAILY_CAP_MIN} to ${DAILY_CAP_MAX}. The default is ${DAILY_CAP_DEFAULT}. Reminders over the limit wait for the next day's send window. Digest emails do not count.`}
      error={error}
    >
      <TextInput
        {...fieldProps("dailyCap", { hasHint: true, error })}
        name="dailyCap"
        type="number"
        inputMode="numeric"
        min={DAILY_CAP_MIN}
        max={DAILY_CAP_MAX}
        step={1}
        aria-required="true"
        className="max-w-[12rem]"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

const HOUR_OPTIONS = DIGEST_HOURS.map((hour) => ({ hour, label: hourLabel(hour) }));

// A checkbox switch whose whole row is the click target, so the touch area is at least 44px tall,
// label included. The native checkbox keeps keyboard, focus and screen reader behaviour.
function ToggleRow({
  id,
  name,
  label,
  description,
  checked,
  onChange,
}: {
  id: string;
  name: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="flex min-h-11 cursor-pointer items-start justify-between gap-6 py-2.5">
      <span className="min-w-0">
        <span className="block text-[14px] font-medium text-ink">{label}</span>
        <span className="mt-0.5 block text-[13px] leading-5 text-ink-3">{description}</span>
      </span>
      <span className="relative mt-0.5 inline-flex h-6 w-11 shrink-0">
        <input
          id={id}
          name={name}
          type="checkbox"
          role="switch"
          checked={checked}
          onChange={(e) => onChange(e.currentTarget.checked)}
          className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-full border border-line-strong bg-surface-2 transition-colors duration-200 peer-checked:border-accent peer-checked:bg-accent peer-focus-visible:ring-[3px] peer-focus-visible:ring-accent/25"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-[3px] left-[3px] h-[18px] w-[18px] rounded-full bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.25)] transition-transform duration-200 ease-out peer-checked:translate-x-5"
        />
      </span>
    </label>
  );
}

export function DigestFields({
  enabled,
  onEnabledChange,
  hour,
  onHourChange,
  timezone,
  error,
  showSwitch = true,
}: {
  enabled: boolean;
  onEnabledChange: (on: boolean) => void;
  hour: string;
  onHourChange: (hour: string) => void;
  timezone: string;
  error?: string;
  showSwitch?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      {showSwitch ? (
        <ToggleRow
          id="digestEnabled"
          name="digestEnabled"
          label="Send me a daily digest (optional)"
          description="One email to your sign-in address when something needs you, or when reminders are planned in the next 24 hours. It is only sent when there is something to report. Turning it off does not affect reminders."
          checked={enabled}
          onChange={onEnabledChange}
        />
      ) : null}
      <div className="pt-4">
        <Field
          id="digestHour"
          label="Send at"
          hint={`The hour, in ${timezone}. The default is ${hourLabel(DIGEST_HOUR_DEFAULT)}.`}
          error={error}
        >
          <Select
            {...fieldProps("digestHour", { hasHint: true, error })}
            name="digestHour"
            value={hour}
            onChange={(e) => onHourChange(e.target.value)}
            className="max-w-[12rem]"
          >
            {HOUR_OPTIONS.map((option) => (
              <option key={option.hour} value={String(option.hour)}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </div>
  );
}
