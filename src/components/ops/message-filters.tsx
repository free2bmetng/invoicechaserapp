"use client";

// The message log filters. On a phone they sit behind one "Filters" toggle, so the first message is
// near the top. On desktop they are one aligned row. It is still a plain GET form.
import Link from "next/link";
import { useState } from "react";
import { Button, Field, Select, cx } from "@/components/ui";
import { DELIVERY_STATUS_LABEL, DELIVERY_STATUSES, LINK_BUTTON_SECONDARY, type DeliveryStatus } from "./kinds";

export function MessageFilters({
  status,
  clientId,
  clients,
}: {
  status: DeliveryStatus | null;
  clientId: string | null;
  clients: { id: string; name: string }[];
}) {
  const filtered = status !== null || clientId !== null;
  const activeCount = [status, clientId].filter(Boolean).length;
  const [open, setOpen] = useState(filtered);
  return (
    <div className="grid gap-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="message-filters"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex min-h-11 items-center justify-between rounded-[12px] border border-line-strong bg-surface px-4 text-[14px] font-medium text-ink shadow-card sm:hidden"
      >
        Filters{activeCount > 0 ? ` (${activeCount})` : ""}
        <span className="text-ink-3">{open ? "Hide" : "Show"}</span>
      </button>
      <form
        id="message-filters"
        method="get"
        action="/messages"
        className={cx(
          "gap-4 rounded-[var(--radius-lg)] border border-line bg-surface p-5 shadow-card sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end sm:p-6",
          open ? "grid" : "hidden sm:grid",
        )}
      >
        <Field id="filter-status" label="Delivery status">
          <Select id="filter-status" name="status" defaultValue={status ?? ""}>
            <option value="">All statuses</option>
            {DELIVERY_STATUSES.map((value) => (
              <option key={value} value={value}>
                {DELIVERY_STATUS_LABEL[value]}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="filter-client" label="Client">
          <Select id="filter-client" name="client" defaultValue={clientId ?? ""}>
            <option value="">All clients</option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center">
          <Button type="submit" variant="secondary" className="w-full sm:w-auto">
            Apply filters
          </Button>
          {filtered ? (
            <Link href="/messages" className={LINK_BUTTON_SECONDARY}>
              Clear filters
            </Link>
          ) : null}
        </div>
      </form>
    </div>
  );
}
