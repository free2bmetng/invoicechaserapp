// Settings is split into sub-pages. The header and the tabs stay put while the page below changes.
import { PageHeader } from "@/components/ui";
import { SettingsTabs } from "@/components/settings/settings-tabs";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PageHeader title="Settings" description="Who reminders come from, when they go out, and how you get paid." />
      <div className="mt-6">
        <SettingsTabs />
      </div>
      <div className="mt-8 max-w-3xl">{children}</div>
    </>
  );
}
