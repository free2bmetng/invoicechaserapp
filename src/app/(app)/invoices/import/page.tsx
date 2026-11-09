import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader, Card } from "@/components/ui";
import { ImportWizard } from "@/components/invoices/import-wizard";
import { INVOICE_CSV_HEADERS } from "@/lib/csv";

export const metadata: Metadata = { title: "Import invoices" };

// The example as field and value pairs, one per line, so no identifier breaks across lines.
const EXAMPLE_VALUES = ["Acme Ltd", "accounts@acme.test", "INV-1001", "1250.00", "USD", "2026-10-01", "2026-10-15"];

export default function ImportPage() {
  return (
    <>
      <Link href="/invoices" className="inline-flex text-[14px] font-medium text-ink-2 underline-offset-4 hover:text-ink hover:underline">
        ← Back to invoices
      </Link>
      <PageHeader
        title="Import invoices"
        description="Bring in invoices from a spreadsheet. Every row is checked first, and you confirm before anything is imported."
        actions={
          <a
            href="/invoices/import/template"
            download
            className="inline-flex h-11 items-center justify-center rounded-[10px] border border-line-strong bg-surface px-4 text-sm font-medium text-ink shadow-card hover:border-ink-3 hover:bg-surface-2 sm:h-10"
          >
            Download template
          </a>
        }
      />
      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] lg:items-start">
        <Card as="section" className="p-5 sm:p-6">
          <ImportWizard />
        </Card>
        <aside aria-labelledby="columns-heading" className="grid min-w-0 gap-4">
          <Card as="section" className="grid gap-4 p-5">
            <h2 id="columns-heading" className="text-[15px] font-semibold text-ink">Column headers</h2>
            <p className="text-[13px] leading-5 text-ink-3">The first row must contain these names, exactly. Other columns are ignored.</p>
            <ul className="flex flex-wrap gap-2" aria-label="Required column headers">
              {INVOICE_CSV_HEADERS.map((name) => (
                <li key={name}>
                  <code className="inline-flex rounded-[8px] border border-line bg-surface-2 px-2.5 py-1 font-mono text-[13px] font-medium text-ink">{name}</code>
                </li>
              ))}
            </ul>
            <ul className="grid gap-2 text-[13px] leading-5 text-ink-3">
              <li><span className="font-medium text-ink-2">amount</span> is a decimal with a point and no thousands separator, such as 1234.50.</li>
              <li><span className="font-medium text-ink-2">currency</span> is an ISO 4217 code, such as USD, EUR or GBP.</li>
              <li><span className="font-medium text-ink-2">issue_date</span> and <span className="font-medium text-ink-2">due_date</span> are YYYY-MM-DD. The due date is on or after the issue date.</li>
              <li><span className="font-medium text-ink-2">client_email</span> matches the client, ignoring case. A new client is created when none matches.</li>
            </ul>
          </Card>
          <Card as="section" className="grid min-w-0 gap-3 p-5">
            <h2 className="text-[15px] font-semibold text-ink">Example row</h2>
            <dl className="grid gap-2 rounded-[var(--radius-md)] bg-surface-2 p-3" aria-label="Example row">
              {INVOICE_CSV_HEADERS.map((name, i) => (
                <div key={name} className="grid grid-cols-[8.5rem_minmax(0,1fr)] items-baseline gap-3 text-[13px] leading-5">
                  <dt className="font-mono font-medium text-ink-2">{name}</dt>
                  <dd className="num min-w-0 break-all text-ink">{EXAMPLE_VALUES[i]}</dd>
                </div>
              ))}
            </dl>
            <ul className="grid gap-1.5 text-[13px] leading-5 text-ink-3">
              <li>Up to 5,000 rows and 2 MB per file.</li>
              <li>Imported invoices start as open, and their reminders are planned from the due date.</li>
              <li>Nothing is overwritten. An import never changes an existing invoice.</li>
            </ul>
          </Card>
        </aside>
      </div>
    </>
  );
}
