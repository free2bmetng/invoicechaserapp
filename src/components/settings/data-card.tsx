// Server-rendered: a plain link to the export route, which requires a session and streams the zip.
import { cx } from "@/components/ui";
import { SettingsCard } from "./form-kit";

export function DataCard() {
  return (
    <SettingsCard
      id="your-data"
      level={3}
      title="Your data"
      description={
        <p>
          Download everything in your account as a zip of CSV files: clients, contacts, invoices, reminder sequences,
          messages, the message log and events. Secrets such as your Stripe key are never included.
        </p>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-[13.5px] leading-6 text-ink-3">
          There is one CSV file per table. Cells that begin with =, +, - or @ get an apostrophe in front, so a spreadsheet
          shows them as text rather than running them.
        </p>
        <div>
          <a
            href="/api/export"
            download
            className={cx(
              "lift inline-flex h-10 items-center justify-center gap-2 rounded-[10px] border border-line-strong bg-surface px-4 text-sm font-medium whitespace-nowrap text-ink shadow-card",
              "hover:border-ink-3 hover:bg-surface-2",
            )}
          >
            Download my data (.zip)
          </a>
        </div>
      </div>
    </SettingsCard>
  );
}
