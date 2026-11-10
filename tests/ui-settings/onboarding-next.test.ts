// The setup checklist highlights one next step with one primary "Continue". These pin which step
// that is, and that the rendered checklist has exactly one primary action pointing at it while
// every step stays reachable as a link (the phone has no other way to reach them).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OnboardingChecklist, ONBOARDING_STEP_PATHS } from "@/components/settings/onboarding-steps";
import { nextOnboardingStep, onboardingSteps, type SettingsRecord } from "@/lib/queries/settings";

const BLANK: SettingsRecord = {
  senderName: "",
  businessName: "",
  postalAddress: "",
  timezone: "Europe/London",
  sendWindowStart: 9,
  sendWindowEnd: 17,
  dailyCap: 20,
  digestEnabled: true,
  digestHour: 8,
  sendingDomain: null,
  onboardingDone: false,
};

const PROFILE = { senderName: "Maya Okafor", businessName: "Okafor Studio", postalAddress: "14 Canal Street\nManchester" };

function steps(options: { profile?: boolean; domain?: boolean; invoices?: number; reviewed?: boolean } = {}) {
  return onboardingSteps({
    settings: {
      ...BLANK,
      ...(options.profile ? PROFILE : {}),
      sendingDomain: options.domain ? "mail.okafor.test" : null,
    },
    invoiceCount: options.invoices ?? 0,
    sequenceReviewed: options.reviewed ?? false,
  });
}

describe("nextOnboardingStep", () => {
  it("starts with the sender details on a new account", () => {
    expect(nextOnboardingStep(steps(), false)).toEqual({ kind: "step", key: "profile" });
  });

  it("moves to the sending domain once the profile is complete", () => {
    expect(nextOnboardingStep(steps({ profile: true }), false)).toEqual({ kind: "step", key: "sending" });
  });

  it("skips the optional invoices step and goes to the review", () => {
    expect(nextOnboardingStep(steps({ profile: true, domain: true }), false)).toEqual({ kind: "step", key: "review" });
  });

  it("picks the earliest unfinished required step, even when a later one is done", () => {
    expect(nextOnboardingStep(steps({ domain: true, reviewed: true }), false)).toEqual({ kind: "step", key: "profile" });
  });

  it("offers Finish once every required step is done, with or without invoices", () => {
    expect(nextOnboardingStep(steps({ profile: true, domain: true, reviewed: true }), false)).toEqual({ kind: "finish" });
    expect(nextOnboardingStep(steps({ profile: true, domain: true, reviewed: true, invoices: 3 }), false)).toEqual({ kind: "finish" });
  });

  it("reports done once setup is finished", () => {
    expect(nextOnboardingStep(steps({ profile: true, domain: true, reviewed: true }), true)).toEqual({ kind: "done" });
  });
});

describe("the checklist", () => {
  function render(options: Parameters<typeof steps>[0], done = false) {
    const list = steps(options);
    return renderToStaticMarkup(createElement(OnboardingChecklist, { steps: list, next: nextOnboardingStep(list, done) }));
  }

  it("highlights the next step with the one Continue, and keeps every step reachable", () => {
    const html = render({ profile: true });
    expect(html.match(/>Continue</g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="step"/);
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    // The Continue link goes to the sending step.
    expect(html).toMatch(new RegExp(`href="${ONBOARDING_STEP_PATHS.sending}"[^>]*>Continue<`));
    for (const path of Object.values(ONBOARDING_STEP_PATHS)) expect(html).toContain(`href="${path}"`);
    expect(html).toContain('aria-valuenow="1"');
    expect(html).not.toContain(">Finish setup</button>");
  });

  it("shows Finish as the one primary action when the required steps are done", () => {
    const html = render({ profile: true, domain: true, reviewed: true });
    expect(html).not.toMatch(/>Continue</);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Finish setup<\/button>/);
  });

  it("offers the dashboard once setup is finished", () => {
    const html = render({ profile: true, domain: true, reviewed: true }, true);
    expect(html).toContain("Setup is complete");
    expect(html).toContain("Go to the dashboard");
    expect(html).not.toMatch(/aria-current="step"/);
  });
});
