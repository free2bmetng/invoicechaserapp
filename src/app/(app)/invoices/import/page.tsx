import type { Metadata } from "next";
import { PageHeader } from "@/components/ui";
import { BackLink } from "@/components/invoices/back-link";
import { ImportWizard } from "@/components/invoices/import-wizard";
import { LinkButton } from "@/components/invoices/link-button";

export const metadata: Metadata = { title: "Import invoices" };

export default function ImportPage() {
  return (
    <>
      <BackLink href="/invoices">Invoices</BackLink>
      <PageHeader
        title="Import invoices"
        description="Bring in invoices from a spreadsheet. Every row is checked first, and nothing is imported until you confirm."
        actions={<LinkButton href="/invoices/import/template" variant="secondary">Download template</LinkButton>}
      />
      <div className="mt-6 max-w-4xl sm:mt-8">
        <ImportWizard />
      </div>
    </>
  );
}
