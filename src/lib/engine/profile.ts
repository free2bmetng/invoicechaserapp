// Sender profile check, mapped from the settings row. The rule itself lives in
// templates.ts (isSenderProfileComplete); this only adapts column names.
import { isSenderProfileComplete } from "@/lib/templates";

export interface SettingsProfileColumns {
  sender_name: string;
  business_name: string;
  postal_address: string;
}

export function settingsProfileComplete(settings: SettingsProfileColumns): boolean {
  return isSenderProfileComplete({
    senderName: settings.sender_name,
    businessName: settings.business_name,
    postalAddress: settings.postal_address,
  });
}
