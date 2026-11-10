"use client";

// Field-level inputs for the schedule settings. Shared by the settings cards and by onboarding
// step 1, so the two screens cannot drift apart.
import { useEffect, useState } from "react";
import { Button, Select, Switch, TextInput, Textarea } from "@/components/ui";
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
        hint="How clients see you in the From line, for example Ada Lovelace."
        error={errors.senderName}
      >
        <TextInput
          {...fieldProps("senderName", { hasHint: true, error: errors.senderName })}
          name="senderName"
          autoComplete="name"
          aria-required="true"
          maxLength={SENDER_NAME_LIMIT}
          value={values.senderName}
          onChange={(e) => onChange({ senderName: e.target.value })}
        />
      </Field>

      <Field
        id="businessName"
        label="Business name"
        hint="Shown in the footer of every reminder, for example Ada Studio Ltd."
        error={errors.businessName}
      >
        <TextInput
          {...fieldProps("businessName", { hasHint: true, error: errors.businessName })}
          name="businessName"
          autoComplete="organization"
          aria-required="true"
          maxLength={BUSINESS_NAME_LIMIT}
          value={values.businessName}
          onChange={(e) => onChange({ businessName: e.target.value })}
        />
      </Field>

      <Field
        id="postalAddress"
        label="Postal address"
        hint="Put each part of the address on its own line."
        error={errors.postalAddress}
      >
        <Textarea
          {...fieldProps("postalAddress", { hasHint: true, error: errors.postalAddress })}
          name="postalAddress"
          autoComplete="street-address"
          aria-required="true"
          maxLength={POSTAL_ADDRESS_LIMIT}
          rows={3}
          className="max-w-md"
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
        hint="Type a city or region, such as Europe/London, and pick it from the list."
        error={error}
      >
        <div className="relative max-w-md">
          <TextInput
            {...fieldProps("timezone", { hasHint: true, error })}
            name="timezone"
            list={DATALIST_ID}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-required="true"
            width="full"
            className="pr-9 [&::-webkit-calendar-picker-indicator]:hidden"
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
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-ink-2">
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
    <div className="grid max-w-md grid-cols-2 gap-4">
      <Field id="windowStart" label="Starts at" error={errors.windowStart}>
        <Select
          {...fieldProps("windowStart", { error: errors.windowStart })}
          width="full"
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

      <Field id="windowEnd" label="Ends at" error={errors.windowEnd}>
        <Select
          {...fieldProps("windowEnd", { error: errors.windowEnd })}
          width="full"
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
      hint={`From ${DAILY_CAP_MIN} to ${DAILY_CAP_MAX}. The default is ${DAILY_CAP_DEFAULT}. Extra reminders wait for the next day.`}
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
        width="short"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

const HOUR_OPTIONS = DIGEST_HOURS.map((hour) => ({ hour, label: hourLabel(hour) }));

export function DigestFields({
  enabled,
  onEnabledChange,
  hour,
  onHourChange,
  timezone,
  error,
}: {
  enabled: boolean;
  onEnabledChange: (on: boolean) => void;
  hour: string;
  onHourChange: (hour: string) => void;
  timezone: string;
  error?: string;
}) {
  return (
    <div className="flex max-w-md flex-col gap-3">
      <Switch
        id="digestEnabled"
        name="digestEnabled"
        label="Send me a daily digest"
        description="One email to your sign-in address, only on days with something to report."
        checked={enabled}
        onChange={onEnabledChange}
      />
      {enabled ? (
        <Field id="digestHour" label="Send at" hint={`In ${timezone}. The default is ${hourLabel(DIGEST_HOUR_DEFAULT)}.`} error={error}>
          <Select
            {...fieldProps("digestHour", { hasHint: true, error })}
            name="digestHour"
            value={hour}
            onChange={(e) => onHourChange(e.target.value)}
            width="short"
          >
            {HOUR_OPTIONS.map((option) => (
              <option key={option.hour} value={String(option.hour)}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        // The hour is kept while the digest is off, so turning it back on restores it.
        <input type="hidden" name="digestHour" value={hour} />
      )}
    </div>
  );
}
