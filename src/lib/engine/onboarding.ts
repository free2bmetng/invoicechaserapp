// Onboarding finish (spec 3.8). Messages are planned only after the sender profile,
// the sending domain and the default sequence review are done. The finish step sets
// the flag and plans every open invoice at once.
import type { Clock } from "@/lib/clock";
import { withUser } from "@/lib/db";
import { ValidationError } from "./errors";
import { planOpenInvoices } from "./invoices";
import { settingsProfileComplete } from "./profile";
import * as S from "./store";
import { logEvent } from "./store";

export interface OnboardingResult {
  // Invoices that were planned by this call.
  planned: number;
  alreadyDone: boolean;
}

// Refuses to finish while the sender profile or the sending domain is missing. The
// sequence review is a UI step; the UI calls this only after it is done.
export async function completeOnboarding(userId: string, clock: Clock): Promise<OnboardingResult> {
  const alreadyDone = await withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    const settings = await S.loadSettings(c, userId);
    const missing: string[] = [];
    if (!settingsProfileComplete(settings)) missing.push("sender name, business name and postal address");
    if ((settings.sending_domain ?? "").trim() === "") missing.push("a sending domain");
    if (missing.length > 0) {
      throw new ValidationError(`Finish setup before planning messages: add ${missing.join(" and ")}.`);
    }
    if (settings.onboarding_done) return true;
    await c.query("update settings set onboarding_done = true, updated_at = $2 where user_id = $1", [userId, clock.now()]);
    await logEvent(c, { userId, type: "onboarding_completed", detail: {}, at: clock.now() });
    return false;
  });
  const planned = await planOpenInvoices(userId, clock);
  return { planned, alreadyDone };
}
