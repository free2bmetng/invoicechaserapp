import type { Metadata } from "next";
import Link from "next/link";
import { StatePanel, buttonClass } from "@/components/ui";

export const metadata: Metadata = { title: "Page not found" };

// Root 404: unmatched URLs and notFound() calls without a closer boundary.
export default function NotFound() {
  return (
    <main className="min-h-dvh bg-bg">
      <StatePanel
        code="404"
        title="We couldn't find that page"
        body={
          <p>
            The link may be old, or the invoice or client may have been removed. Nothing has been sent or changed.
          </p>
        }
        actions={
          <>
            <Link href="/invoices" className={buttonClass("secondary")}>
              View invoices
            </Link>
            <Link href="/" className={buttonClass("primary")}>
              Go to dashboard
            </Link>
          </>
        }
      />
    </main>
  );
}
