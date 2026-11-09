// Shared data primitives (DESIGN_V2 "Shared building blocks"). Server-safe:
// nothing here uses state or effects. EditableSection is the one client part;
// it lives in ./data-client and is re-exported below.
//
// Phone (< sm, 640px): tables turn into compact two-line rows. Cells marked
// `primary` form line 1; the rest follow on line 2 with their `label` shown
// inline. Empty cells are dropped on phone so there are no blank label rows.

import Link from "next/link";
import { DateTime } from "luxon";
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { cx, type Tone } from "./ui";
import { Money } from "./money";

export { EditableSection, EditCancelButton, useEditableSection } from "./data-client";

export type EdgeTone = "danger" | "warn";
export type StatTone = "neutral" | "warn" | "danger" | "ok";

const fillClass: Record<Tone, string> = {
  neutral: "bg-neutral-fill",
  accent: "bg-accent",
  warn: "bg-warn-fill",
  danger: "bg-danger-fill",
  ok: "bg-ok-fill",
  info: "bg-info-fill",
};

function isEmpty(node: ReactNode): boolean {
  return node === null || node === undefined || node === false || node === "";
}

// Anchor stretched over its row (the row is `relative`). Its own outline is
// replaced by a ring drawn on the stretched area, so focus shows the whole row.
const stretchedAnchor =
  "outline-none focus-visible:outline-none after:absolute after:inset-0 after:content-[''] " +
  "focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-solid focus-visible:after:outline-focus " +
  "focus-visible:after:rounded-[inherit]";

/* ───────────────────────── Table ───────────────────────── */

// Scroll container + <table> with an sr-only caption. No outer frame: put it in
// a <Card> (with overflow-hidden) for a framed table.
export function Table({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="w-full overflow-x-auto">
      <table className="w-full border-collapse text-body max-sm:block">
        <caption className="sr-only">{label}</caption>
        {children}
      </table>
    </div>
  );
}

// Header row. Pass <Th> cells directly (a header <tr> is added for you), or
// your own <Tr> of <Th> cells. Hidden on phone: each cell carries its own label.
export function THead({ children }: { children: ReactNode }) {
  const hasRow = Children.toArray(children).some((c) => isValidElement(c) && c.type === Tr);
  return (
    <thead className="max-sm:hidden">
      {hasRow ? children : <tr>{children}</tr>}
    </thead>
  );
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody className="max-sm:block">{children}</tbody>;
}

const rowEdge: Record<EdgeTone, string> = {
  danger:
    "max-sm:shadow-[inset_3px_0_0_var(--color-danger-fill)] sm:[&>td:first-child]:shadow-[inset_3px_0_0_var(--color-danger-fill)]",
  warn:
    "max-sm:shadow-[inset_3px_0_0_var(--color-warn-fill)] sm:[&>td:first-child]:shadow-[inset_3px_0_0_var(--color-warn-fill)]",
};

// `href` makes the whole row one link: the first <Td>'s content becomes an
// anchor stretched over the row, so it is one tab stop with a visible ring.
// Buttons or links in other cells stay clickable above it.
export function Tr({ href, children, tone }: { href?: string; children: ReactNode; tone?: EdgeTone }) {
  let content = children;
  if (href) {
    let linked = false;
    content = Children.map(children, (child) => {
      if (!linked && isValidElement(child) && child.type === Td) {
        linked = true;
        return cloneElement(child as ReactElement<TdProps>, { rowHref: href });
      }
      return child;
    });
  }
  return (
    <tr
      data-row-link={href ? "" : undefined}
      className={cx(
        "border-b border-line last:border-b-0",
        // Phone: line 1 = primary cells, a zero-height break, line 2 = the rest.
        "max-sm:flex max-sm:flex-wrap max-sm:items-baseline max-sm:gap-x-3 max-sm:px-4 max-sm:py-3",
        "max-sm:after:order-1 max-sm:after:basis-full max-sm:after:content-['']",
        href && "relative cursor-pointer transition-colors duration-150 hover:bg-surface-2/70",
        tone && rowEdge[tone],
      )}
    >
      {content}
    </tr>
  );
}

function SortMark({ sorted }: { sorted?: "asc" | "desc" }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      aria-hidden="true"
      className={cx("shrink-0", sorted ? "text-ink-2" : "text-ink-3 opacity-0 group-hover:opacity-100")}
    >
      {sorted === "asc" ? (
        <path d="M5 2.5 8 6.5H2z" fill="currentColor" />
      ) : sorted === "desc" ? (
        <path d="M5 7.5 2 3.5h6z" fill="currentColor" />
      ) : (
        <path d="M5 1.5 7.5 4h-5zM5 8.5 2.5 6h5z" fill="currentColor" />
      )}
    </svg>
  );
}

export function Th({
  children,
  align = "left",
  sortHref,
  sorted,
}: {
  children: ReactNode;
  align?: "left" | "right";
  sortHref?: string;
  sorted?: "asc" | "desc";
}) {
  return (
    <th
      scope="col"
      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
      className={cx(
        "h-10 border-b border-line px-3 text-[12.5px] leading-5 font-medium whitespace-nowrap text-ink-3 first:pl-5 last:pr-5",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      {sortHref ? (
        <Link
          href={sortHref}
          scroll={false}
          className={cx(
            "group inline-flex items-center gap-1 rounded-[4px] hover:text-ink",
            sorted && "text-ink-2",
            align === "right" && "flex-row-reverse",
          )}
        >
          {children}
          <SortMark sorted={sorted} />
        </Link>
      ) : (
        children
      )}
    </th>
  );
}

type TdProps = {
  children?: ReactNode;
  align?: "left" | "right";
  /** Shown on phone only, as the inline label in the stacked row. */
  label?: string;
  /** Shown on the first line of the phone row. */
  primary?: boolean;
  /** Tabular numerals, right aligned, no wrapping. */
  numeric?: boolean;
  /** Set by <Tr href>; do not pass yourself. */
  rowHref?: string;
};

export function Td({ children, align, label, primary, numeric, rowHref }: TdProps) {
  const right = align === "right" || (numeric && align !== "left");
  const empty = isEmpty(children);
  return (
    <td
      className={cx(
        "align-middle sm:px-3 sm:py-3 sm:first:pl-5 sm:last:pr-5",
        right && "sm:text-right",
        numeric && "num whitespace-nowrap",
        primary
          ? cx("max-sm:order-0 max-sm:min-w-0 max-sm:font-medium max-sm:text-ink", numeric ? "max-sm:ml-auto" : "max-sm:flex-1 max-sm:truncate")
          : "max-sm:order-2 max-sm:mt-1 max-sm:text-small max-sm:text-ink-2",
        rowHref ? "font-medium text-ink" : "text-ink-2 first:text-ink",
        empty && "max-sm:hidden",
      )}
    >
      {label && !primary ? <span className="mr-1.5 text-ink-3 sm:hidden">{label}</span> : null}
      {rowHref ? (
        <Link href={rowHref} data-row-anchor="" className={stretchedAnchor}>
          {children}
        </Link>
      ) : (
        children
      )}
    </td>
  );
}

/* ───────────────────────── StatTile ───────────────────────── */

const statValueTone: Record<StatTone, string> = {
  neutral: "text-ink",
  warn: "text-warn",
  danger: "text-danger",
  ok: "text-ok",
};

const statDotTone: Record<StatTone, string> = {
  neutral: "",
  warn: "bg-warn-fill",
  danger: "bg-danger-fill",
  ok: "bg-ok-fill",
};

export function StatTile({
  label,
  value,
  sub,
  tone = "neutral",
  href,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: StatTone;
  href?: string;
}) {
  const body = (
    <>
      <span className="flex items-center gap-2 text-small font-medium text-ink-2">
        {tone !== "neutral" ? <span aria-hidden="true" className={cx("size-1.5 shrink-0 rounded-full", statDotTone[tone])} /> : null}
        <span className="min-w-0 truncate">{label}</span>
        {href ? (
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            aria-hidden="true"
            className="ml-auto shrink-0 text-ink-3 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-ink-2"
          >
            <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : null}
      </span>
      <span className={cx("num block truncate text-[28px] leading-8 font-semibold tracking-[-0.02em] sm:text-stat", statValueTone[tone])}>
        {value}
      </span>
      {sub ? <span className="block text-small text-ink-3">{sub}</span> : null}
    </>
  );
  const frame =
    "group flex min-w-0 flex-col gap-1.5 rounded-[var(--radius-md)] border border-line bg-surface p-4 shadow-card sm:p-5";
  return href ? (
    <Link href={href} className={cx(frame, "lift hover:border-line-strong hover:bg-surface-2/40")}>
      {body}
    </Link>
  ) : (
    <div className={frame}>{body}</div>
  );
}

/* ───────────────────────── AgingBar ───────────────────────── */

export type AgingBucket = { label: string; amountMinor: number; tone: Tone };

// Stacked bar + legend for one currency. The legend carries the numbers (the
// bar is decorative for assistive tech). Zero buckets stay in the legend only.
export function AgingBar({ buckets, currency }: { buckets: AgingBucket[]; currency: string }) {
  const total = buckets.reduce((sum, b) => sum + Math.max(0, b.amountMinor), 0);
  return (
    <div className="flex flex-col gap-4">
      <div aria-hidden="true" className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full bg-surface-3">
        {total > 0
          ? buckets
              .filter((b) => b.amountMinor > 0)
              .map((b, i) => (
                <span
                  key={`${b.label}-${i}`}
                  className={cx("h-full min-w-[4px] basis-0 first:rounded-l-full last:rounded-r-full", fillClass[b.tone])}
                  style={{ flexGrow: b.amountMinor }}
                />
              ))
          : null}
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:flex sm:flex-wrap sm:gap-x-8">
        {buckets.map((b, i) => (
          <div key={`${b.label}-${i}`} className="min-w-0">
            <dt className="flex items-center gap-2 text-small text-ink-2">
              <span aria-hidden="true" className={cx("size-2 shrink-0 rounded-[3px]", fillClass[b.tone])} />
              <span className="truncate">{b.label}</span>
            </dt>
            <dd className={cx("mt-0.5 pl-4 text-body font-medium", b.amountMinor > 0 ? "text-ink" : "text-ink-3")}>
              <Money minor={b.amountMinor} currency={currency} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/* ───────────────────────── SummaryList ───────────────────────── */

export type SummaryItem = { label: string; value: ReactNode };

// Read-only definition list: label | value on desktop, stacked on phone.
// Empty values read "Not set" rather than a bare dash.
export function SummaryList({ items }: { items: SummaryItem[] }) {
  return (
    <dl className="divide-y divide-line">
      {items.map((item, i) => (
        <div
          key={`${item.label}-${i}`}
          className="grid gap-0.5 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] sm:gap-6"
        >
          <dt className="text-small text-ink-3 sm:text-body sm:text-ink-2">{item.label}</dt>
          <dd className="min-w-0 text-body break-words text-ink">
            {isEmpty(item.value) ? <span className="text-ink-3">Not set</span> : item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* ───────────────────────── SegmentedTabs ───────────────────────── */

export type SegmentedTabItem = { label: string; href: string; count?: number; active: boolean };

// Link tabs for filters and sub-pages. 44px tall on phone, scrolls sideways.
export function SegmentedTabs({ label, items }: { label: string; items: SegmentedTabItem[] }) {
  return (
    <nav aria-label={label} className="max-w-full overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <ul className="inline-flex min-w-max items-center gap-0.5 rounded-[11px] border border-line bg-surface-2 p-[3px]">
        {items.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={item.active ? "page" : undefined}
              className={cx(
                "flex h-11 items-center gap-1.5 rounded-[8px] px-3 text-[13px] leading-5 font-medium whitespace-nowrap transition-colors duration-150 sm:h-8",
                item.active
                  ? "bg-surface text-ink shadow-card ring-1 ring-line"
                  : "text-ink-2 hover:bg-surface-3/70 hover:text-ink",
              )}
            >
              {item.label}
              {item.count !== undefined ? (
                <span className={cx("num text-[12px]", item.active ? "text-ink-2" : "text-ink-3")}>{item.count}</span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/* ───────────────────────── ActionRow ───────────────────────── */

const actionEdge: Record<EdgeTone, string> = {
  danger: "shadow-[inset_3px_0_0_var(--color-danger-fill)]",
  warn: "shadow-[inset_3px_0_0_var(--color-warn-fill)]",
};

// Optional wrapper for a stack of ActionRows. On desktop it lines every row's
// columns up (CSS subgrid), even when rows have different action buttons.
export function ActionList({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div data-action-list="" role={label ? "group" : undefined} aria-label={label}>
      {children}
    </div>
  );
}

// Compact queue row. Desktop: one line (client · title · meta | amount | status | actions)
// on fixed columns, so stacked rows align. Phone: client + amount, then title · meta + status,
// then actions (only when given). Stack rows directly in a container; the last row drops its border.
export function ActionRow({
  href,
  title,
  client,
  meta,
  amount,
  status,
  actions,
  tone,
}: {
  href?: string;
  title: ReactNode;
  client: ReactNode;
  meta?: ReactNode;
  amount?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  tone?: EdgeTone;
}) {
  return (
    <div
      data-action-row=""
      data-row-link={href ? "" : undefined}
      className={cx(
        "relative grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-b border-line px-4 py-3 last:border-b-0",
        "sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_7.5rem_8.5rem_auto] sm:gap-x-4 sm:px-5 lg:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_8rem_9rem_auto]",
        href && "transition-colors duration-150 hover:bg-surface-2/70",
        tone && actionEdge[tone],
      )}
    >
      <div className="col-start-1 row-start-1 min-w-0 truncate text-body font-medium text-ink">{client}</div>
      <div className="col-start-1 row-start-2 min-w-0 truncate text-small text-ink-2 sm:col-start-2 sm:row-start-1 sm:text-body">
        {href ? (
          <Link href={href} data-row-anchor="" className={cx(stretchedAnchor, "text-ink-2 hover:text-ink")}>
            {title}
          </Link>
        ) : (
          title
        )}
        {meta ? <span className="text-ink-3"> · {meta}</span> : null}
      </div>
      <div className="num col-start-2 row-start-1 text-right text-body font-medium whitespace-nowrap text-ink sm:col-start-3">
        {amount}
      </div>
      <div className="col-start-2 row-start-2 flex justify-end sm:col-start-4 sm:row-start-1 sm:justify-start">{status}</div>
      {actions ? (
        <div className="relative z-[1] col-span-2 col-start-1 row-start-3 mt-2 flex flex-wrap items-center gap-2 sm:col-span-1 sm:col-start-5 sm:row-start-1 sm:mt-0 sm:justify-end">
          {actions}
        </div>
      ) : null}
    </div>
  );
}

/* ───────────────────────── Progress ───────────────────────── */

function ratio(value: number, max: number): number {
  if (!(max > 0) || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value / max));
}

// 44px ring with "value/max" in the centre (onboarding checklists).
export function ProgressRing({ value, max, label }: { value: number; max: number; label: string }) {
  const r = 18;
  const c = 2 * Math.PI * r;
  const p = ratio(value, max);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${value} of ${max}`}
      className="relative inline-grid size-11 shrink-0 place-items-center"
    >
      <svg viewBox="0 0 44 44" aria-hidden="true" className="absolute inset-0 -rotate-90">
        <circle cx="22" cy="22" r={r} fill="none" strokeWidth="4" className="stroke-surface-3" />
        {p > 0 ? (
          <circle
            cx="22"
            cy="22"
            r={r}
            fill="none"
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - p)}
            className="stroke-accent transition-[stroke-dashoffset] duration-500"
          />
        ) : null}
      </svg>
      <span aria-hidden="true" className="num text-[11px] leading-none font-semibold text-ink">
        {value}/{max}
      </span>
    </div>
  );
}

// Labelled bar with a percentage (payment plans, imports).
export function ProgressBar({ value, max, label }: { value: number; max: number; label: string }) {
  const p = ratio(value, max);
  return (
    <div className="flex flex-col gap-1.5">
      <div aria-hidden="true" className="flex items-baseline justify-between gap-3 text-small">
        <span className="text-ink-2">{label}</span>
        <span className="num text-ink-3">{Math.round(p * 100)}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        className="h-2 w-full overflow-hidden rounded-full bg-surface-3"
      >
        <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${p * 100}%` }} />
      </div>
    </div>
  );
}

/* ───────────────────────── Timeline ───────────────────────── */

export type TimelineItem = { at: string; title: ReactNode; detail?: ReactNode; tone?: Tone };

// One time format everywhere: "12 Mar 2026, 2:05 PM" in `zone` (pass the
// user's timezone; defaults to UTC). `at` is an ISO timestamp; anything that
// does not parse is shown as given.
export function formatTimelineTime(at: string, zone = "UTC"): string {
  const dt = DateTime.fromISO(at, { zone: "utc" });
  if (!dt.isValid) return at;
  const local = dt.setZone(zone);
  return (local.isValid ? local : dt).setLocale("en").toFormat("d LLL yyyy, h:mm a");
}

export function Timeline({ items, zone }: { items: TimelineItem[]; zone?: string }) {
  return (
    <ol className="flex flex-col">
      {items.map((item, i) => (
        <li
          key={`${item.at}-${i}`}
          className={cx(
            "relative pb-5 pl-6 last:pb-0",
            "before:absolute before:top-[20px] before:bottom-[-2px] before:left-[4.5px] before:w-px before:bg-line-strong before:content-[''] last:before:hidden",
          )}
        >
          <span
            aria-hidden="true"
            className={cx("absolute top-[6px] left-0 size-2.5 rounded-full ring-4 ring-surface", fillClass[item.tone ?? "neutral"])}
          />
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
            <div className="min-w-0 text-body font-medium text-ink">{item.title}</div>
            <time dateTime={item.at} className="num text-small whitespace-nowrap text-ink-3">
              {formatTimelineTime(item.at, zone)}
            </time>
          </div>
          {item.detail ? <div className="mt-0.5 text-small text-ink-2">{item.detail}</div> : null}
        </li>
      ))}
    </ol>
  );
}

/* ───────────────────────── Kbd ───────────────────────── */

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-b-2 border-line-strong bg-surface px-1 font-sans text-[11px] leading-none font-medium text-ink-2">
      {children}
    </kbd>
  );
}
