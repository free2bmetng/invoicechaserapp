"use client";

import Form from "next/form";
import { useRef } from "react";
import { cx } from "@/components/ui";

// Filters the clients table as you type. It is a plain GET form underneath, so Enter works without
// JavaScript too. The current sort is kept.
export function ClientSearch({ q, sort, dir, className }: { q: string; sort?: string; dir?: string; className?: string }) {
  const form = useRef<HTMLFormElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (
    <Form ref={form} action="/clients" replace scroll={false} role="search" className={cx("relative w-full sm:max-w-xs", className)}>
      {sort ? <input type="hidden" name="sort" value={sort} /> : null}
      {dir ? <input type="hidden" name="dir" value={dir} /> : null}
      <label htmlFor="client-search" className="sr-only">Search clients</label>
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3">
        <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <input
        id="client-search"
        type="search"
        name="q"
        defaultValue={q}
        placeholder="Search by name or email"
        autoComplete="off"
        onChange={() => {
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => form.current?.requestSubmit(), 250);
        }}
        className="h-11 w-full rounded-[10px] border border-control-border bg-surface pr-3 pl-9 text-body text-ink placeholder:text-ink-3 sm:h-9"
      />
    </Form>
  );
}
