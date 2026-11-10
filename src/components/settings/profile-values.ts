// The sender and schedule values the profile forms edit, as strings for the inputs.
// Shared by the settings profile page and onboarding step 1.
import type { SettingsRecord } from "@/lib/queries/settings";
import { hourLabel } from "./rules";

export interface ProfileValues {
  senderName: string;
  businessName: string;
  postalAddress: string;
  timezone: string;
  windowStart: string;
  windowEnd: string;
  dailyCap: string;
  digestEnabled: boolean;
  digestHour: string;
}

export function profileValuesFrom(s: SettingsRecord): ProfileValues {
  return {
    senderName: s.senderName,
    businessName: s.businessName,
    postalAddress: s.postalAddress,
    timezone: s.timezone,
    windowStart: String(s.sendWindowStart),
    windowEnd: String(s.sendWindowEnd),
    dailyCap: String(s.dailyCap),
    digestEnabled: s.digestEnabled,
    digestHour: String(s.digestHour),
  };
}

// "09:00 to 17:00" from the stored hours.
export function windowText(values: Pick<ProfileValues, "windowStart" | "windowEnd">): string {
  return `${hourLabel(Number(values.windowStart))} to ${hourLabel(Number(values.windowEnd))}`;
}
