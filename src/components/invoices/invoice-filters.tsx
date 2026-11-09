"use client";

// The list filters. On a phone they sit behind one "Filters" toggle, so the first invoice is near the top.
// On desktop they are one aligned row. It is still a plain GET form, so it works without JavaScript.
import Link from "next/link";
import { useState } from "react";
import { Button, Field, Select, TextInput, cx } from "@/components/ui";
import { INVOICE_STATUSES } from "@/lib/types";
import type { ClientChoice } from "@/lib/queries/invoices";
import { INVOICE_STATUS_LABEL } from "./format";
import type { InvoiceFilterValues } from "./invoice-list";

export function InvoiceFilters({ values, clients }: { values: InvoiceFilterValues; clients: ClientChoice[] }) {
  const filtered = Boolean(values.status || values.clientId || values.q);
  const activeCount = [values.status, values.clientId, values.q].filter(Boolean).length;
  const [open, setOpen] = useState(filtered);
  return (
    <div className="grid gap-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="invoice-filters"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex min-h-11 items-center justify-between rounded-[12px] border border-line-strong bg-surface px-4 text-[14px] font-medium text-ink shadow-card sm:hidden"
      >
        Filters{activeCount > 0 ? ` (${activeCount})` : ""}
        <span className="text-ink-3">{open ? "Hide" : "Show"}</span>
      </button>
    <form id="invoice-filters" method="get" action="/invoices" role="search" aria-label="Filter invoices"
      className={cx("grid gap-3 rounded-[var(--radius-lg)] border border-line bg-surface p-4 shadow-card sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end sm:p-5", open ? "grid" : "hidden sm:grid")}>
      <Field id="filter-q" label="Search" hint="Invoice number or client name.">
        <TextInput id="filter-q" name="q" type="search" defaultValue={values.q} maxLength={100} autoComplete="off" />
      </Field>
      <Field id="filter-status" label="Status">
        <Select id="filter-status" name="status" defaultValue={values.status}>
          <option value="">All statuses</option>
          {INVOICE_STATUSES.map((s) => (
            <option key={s} value={s}>{INVOICE_STATUS_LABEL[s]}</option>
          ))}
        </Select>
      </Field>
      <Field id="filter-client" label="Client">
        <Select id="filter-client" name="client" defaultValue={values.clientId}>
          <option value="">All clients</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </Select>
      </Field>
      <div className="flex items-center gap-2">
        <Button type="submit" variant="secondary">Apply</Button>
        {filtered ? (
          <Link href="/invoices" className="inline-flex h-10 items-center rounded-[10px] px-3 text-sm font-medium text-ink-2 hover:bg-surface-2 hover:text-ink">
            Clear
          </Link>
        ) : null}
      </div>
    </form>
    </div>
  );
}

