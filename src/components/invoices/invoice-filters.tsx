"use client";

// Search and client filter for the invoices table. A plain GET form, so it works without
// JavaScript (Enter submits); with JavaScript the client picker applies as soon as it changes.
// The status tab and the sort travel along as hidden fields.
import { Select, TextInput } from "@/components/ui";
import type { ClientChoice } from "@/lib/queries/invoices";
import type { InvoiceFilterValues } from "./invoice-list";

export function InvoiceFilters({ values, clients }: { values: InvoiceFilterValues; clients: ClientChoice[] }) {
  return (
    <form method="get" action="/invoices" role="search" aria-label="Filter invoices" className="flex w-full gap-2 sm:w-auto">
      {values.status ? <input type="hidden" name="status" value={values.status} /> : null}
      {values.sort ? <input type="hidden" name="sort" value={values.sort} /> : null}
      {values.dir ? <input type="hidden" name="dir" value={values.dir} /> : null}
      <div className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
        <label htmlFor="filter-q" className="sr-only">Search by invoice number or client</label>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3">
          <circle cx="7" cy="7" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <TextInput
          id="filter-q"
          name="q"
          type="search"
          width="full"
          defaultValue={values.q}
          maxLength={100}
          autoComplete="off"
          placeholder="Search number or client"
          className="pl-9 sm:h-10"
        />
      </div>
      <label htmlFor="filter-client" className="sr-only">Client</label>
      <Select
        id="filter-client"
        name="client"
        width="full"
        defaultValue={values.clientId}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="w-[42%] shrink-0 sm:h-10 sm:w-44"
      >
        <option value="">All clients</option>
        {clients.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </Select>
      <button type="submit" className="sr-only">Apply filters</button>
    </form>
  );
}
