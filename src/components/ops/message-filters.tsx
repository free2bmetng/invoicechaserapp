"use client";

// Message log client and search controls. They apply as you choose or type (search waits for a
// short pause), and the URL holds the state, so a filtered view can be shared or reloaded.
// Without JavaScript it is still a plain GET form: Enter in the search box submits it.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Select, TextInput, cx } from "@/components/ui";
import { messageLogHref } from "./kinds";

const SEARCH_DELAY_MS = 250;

export function MessageFilters({
  status,
  clientId,
  q,
  clients,
}: {
  status: string | null;
  clientId: string | null;
  q: string | null;
  clients: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [text, setText] = useState(q ?? "");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function go(next: { client?: string | null; q?: string | null }) {
    const href = messageLogHref({
      status,
      client: next.client === undefined ? clientId : next.client,
      q: next.q === undefined ? text.trim() : next.q,
    });
    startTransition(() => router.replace(href, { scroll: false }));
  }

  return (
    <form
      method="get"
      action="/messages"
      role="search"
      aria-label="Filter messages"
      className="flex flex-col gap-2 sm:flex-row sm:items-center"
      onSubmit={(event) => {
        event.preventDefault();
        if (timer.current) clearTimeout(timer.current);
        go({});
      }}
    >
      {status ? <input type="hidden" name="status" value={status} /> : null}
      <Select
        name="client"
        aria-label="Client"
        width="full"
        className="sm:w-52"
        defaultValue={clientId ?? ""}
        onChange={(event) => go({ client: event.target.value || null })}
      >
        <option value="">All clients</option>
        {clients.map((client) => (
          <option key={client.id} value={client.id}>
            {client.name}
          </option>
        ))}
      </Select>
      <div className="relative sm:w-72">
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          aria-hidden="true"
          className={cx("pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3", pending && "animate-pulse")}
        >
          <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <TextInput
          type="search"
          name="q"
          aria-label="Search messages"
          placeholder="Search client, invoice, subject"
          width="full"
          className="pl-9"
          maxLength={100}
          value={text}
          onChange={(event) => {
            const value = event.target.value;
            setText(value);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => go({ q: value.trim() }), SEARCH_DELAY_MS);
          }}
        />
      </div>
    </form>
  );
}
