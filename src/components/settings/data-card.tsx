// Server-rendered: a plain link to the export route, which requires a session and streams the zip.
import { buttonClass } from "@/components/ui";
import { Panel } from "./form-kit";

export function DataCard() {
  return (
    <Panel
      id="your-data"
      title="Your data"
      description="Everything in your account as a zip of CSV files, one per table. Secrets such as your Stripe key are never included."
      action={
        <a href="/api/export" download className={buttonClass("secondary", "sm")}>
          Download .zip
        </a>
      }
    />
  );
}
