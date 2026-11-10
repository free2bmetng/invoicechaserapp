// /settings is the first sub-page: the sender profile, the sending window and the digest.
// Each section is a read-only summary with Edit, which opens its form in place.
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { EditableSection, SummaryList } from "@/components/data";
import { Callout } from "@/components/settings/form-kit";
import { FooterLines } from "@/components/settings/footer-preview";
import { ProfileSectionForm } from "@/components/settings/profile-section-form";
import { profileValuesFrom, windowText } from "@/components/settings/profile-values";
import { hourLabel } from "@/components/settings/rules";
import { CardsSkeleton } from "@/components/settings/skeleton";
import { getSettingsView } from "@/lib/queries/settings";
import { requireUserId } from "@/lib/session";
import { isSenderProfileComplete } from "@/lib/templates";

export const metadata: Metadata = { title: "Settings" };

type SearchParams = Promise<{ stripe?: string | string[]; reason?: string | string[] }>;

export default function SettingsProfilePage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<CardsSkeleton cards={3} />}>
      <ProfileBody searchParams={searchParams} />
    </Suspense>
  );
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// Reads the session and the account, so it sits behind the Suspense boundary above.
async function ProfileBody({ searchParams }: { searchParams: SearchParams }) {
  // The Stripe Connect return lands on /settings. Its status belongs to the Payments page.
  const params = await searchParams;
  const stripe = first(params.stripe);
  if (stripe) {
    const query = new URLSearchParams({ stripe });
    const reason = first(params.reason);
    if (reason) query.set("reason", reason);
    redirect(`/settings/payments?${query.toString()}`);
  }

  const userId = await requireUserId();
  const view = await getSettingsView(userId);
  const s = view.settings;
  const values = profileValuesFrom(s);
  const complete = isSenderProfileComplete(values);

  return (
    <div className="flex flex-col gap-6">
      {!view.settings.onboardingDone ? (
        <Callout>
          Setup isn&apos;t finished, so no reminders are planned yet.{" "}
          <Link href="/onboarding" className="font-medium text-accent underline underline-offset-4">
            Continue setup
          </Link>
        </Callout>
      ) : null}

      <EditableSection
        title="Sender details"
        description="Every reminder ends with a footer built from these. Reminders stay off until all three are set."
        summary={
          <div className="flex flex-col gap-4">
            {!complete ? (
              <Callout tone="warn">Reminders are off until your name, business name and postal address are all set.</Callout>
            ) : null}
            <SummaryList
              items={[
                { label: "Your name", value: s.senderName },
                { label: "Business name", value: s.businessName },
                {
                  label: "Postal address",
                  value: s.postalAddress ? <span className="whitespace-pre-line">{s.postalAddress}</span> : null,
                },
                {
                  label: "Footer on every reminder",
                  value: complete ? <FooterLines values={values} /> : null,
                },
              ]}
            />
          </div>
        }
      >
        <ProfileSectionForm section="sender" current={values} />
      </EditableSection>

      <EditableSection
        title="Sending window"
        description="When reminders go out, and how many in a day."
        summary={
          <SummaryList
            items={[
              { label: "Your timezone", value: s.timezone },
              {
                label: "Send window",
                value: (
                  <>
                    {windowText(values)}
                    <span className="block text-small text-ink-3">In each client&apos;s timezone, or yours when a client has none.</span>
                  </>
                ),
              },
              { label: "Daily limit", value: <span className="num">{s.dailyCap} reminders a day</span> },
            ]}
          />
        }
      >
        <ProfileSectionForm section="schedule" current={values} />
      </EditableSection>

      <EditableSection
        title="Daily digest"
        description="A summary email to your sign-in address, only on days with something to report."
        summary={
          <SummaryList
            items={[
              {
                label: "Digest",
                value: s.digestEnabled ? `On, at ${hourLabel(s.digestHour)} (${s.timezone})` : "Off",
              },
              { label: "Sent to", value: view.email },
            ]}
          />
        }
      >
        <ProfileSectionForm section="digest" current={values} />
      </EditableSection>
    </div>
  );
}
