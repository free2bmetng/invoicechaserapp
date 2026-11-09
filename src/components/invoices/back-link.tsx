// "← Invoices" above a page title. A 44px target on every screen, aligned to the text edge.
import Link from "next/link";
import type { ReactNode } from "react";

export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="-ml-2 mb-1 inline-flex h-11 items-center gap-1.5 rounded-[8px] px-2 text-[14px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"
    >
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16">
        <path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {children}
    </Link>
  );
}
