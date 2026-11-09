"use client";

// Needs you as a split view (Linear's inbox): the queue on the left, the selected item on the
// right from xl up. Below xl the selected row opens in place. J and K move, A approves.
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { approveReminder } from "@/app/actions/ops";
import { ActionList, ActionRow } from "@/components/data";
import { MoneyList } from "@/components/money";
import { Card, cx } from "@/components/ui";
import type { NeedsYouRow, NeedsYouSection } from "@/lib/queries/ops";
import { useOpsAction } from "./feedback";
import { hasQuickAction } from "./kinds";
import { ApproveAllButton, NeedsYouDetail, RowQuickAction } from "./needs-you-card";

const SECTION_DOT: Record<string, string> = {
  failed: "bg-danger-fill",
  needs_check: "bg-warn-fill",
  bounce: "bg-danger-fill",
  approval: "bg-warn-fill",
  reply: "bg-accent",
  paid_while_disputed: "bg-warn-fill",
  disputed: "bg-warn-fill",
};

function rowButtonId(key: string): string {
  return `ny-${key.replace(/[^a-z0-9]/gi, "")}`;
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

export function NeedsYouWorkspace({ sections, initialKey }: { sections: NeedsYouSection[]; initialKey: string | null }) {
  const rows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);
  // The selection keeps its key and its position. When the item leaves the queue (approved,
  // retried), the row that moved into its position takes over, so the next item is selected.
  const [selection, setSelection] = useState<{ key: string | null; index: number }>(() => {
    const index = Math.max(0, rows.findIndex((row) => row.key === initialKey));
    return { key: rows[index]?.key ?? null, index };
  });
  // Below xl the selected row opens in place; it starts closed unless a link named the item.
  const [expanded, setExpanded] = useState(() => rows.some((row) => row.key === initialKey));
  const { pending, run } = useOpsAction({ banner: true });

  let index = rows.findIndex((row) => row.key === selection.key);
  if (index === -1 && rows.length > 0) index = Math.min(selection.index, rows.length - 1);
  const selected: NeedsYouRow | null = index >= 0 ? rows[index] : null;
  const select = useCallback((i: number) => setSelection({ key: rows[i]?.key ?? null, index: i }), [rows]);

  const focusRow = useCallback((key: string) => {
    const el = document.getElementById(rowButtonId(key));
    el?.focus({ preventScroll: true });
    el?.closest("[data-action-row]")?.scrollIntoView({ block: "nearest" });
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      const key = event.key.toLowerCase();
      if ((key === "j" || key === "k") && rows.length > 0) {
        event.preventDefault();
        const next = Math.max(0, Math.min(rows.length - 1, (index < 0 ? 0 : index) + (key === "j" ? 1 : -1)));
        select(next);
        focusRow(rows[next].key);
      } else if (key === "a" && selected?.kind === "approval" && selected.messageId && !pending) {
        event.preventDefault();
        void run(approveReminder, { messageId: selected.messageId });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, index, selected, pending, run, focusRow, select]);

  function onRowClick(key: string) {
    if (key === selected?.key) setExpanded((open) => !open);
    else {
      select(rows.findIndex((row) => row.key === key));
      setExpanded(true);
    }
  }

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_25rem]">
      <Card as="div" className="overflow-hidden">
        <div
          className={cx(
            "xl:[&_[data-action-row]:has([aria-current=true])]:bg-accent-soft/70",
            "[&_[data-action-row]:has([aria-expanded=true])]:bg-surface-2 xl:[&_[data-action-row]:has([aria-expanded=true])]:bg-accent-soft/70",
          )}
        >
          <ActionList label="Needs you">
            {sections.map((section) => (
              <Fragment key={section.kind}>
                <div className="col-span-full flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-line bg-surface-2 px-4 py-2.5 sm:px-5">
                  <h2 className="flex items-center gap-2 text-small font-semibold text-ink">
                    <span aria-hidden="true" className={cx("size-1.5 rounded-full", SECTION_DOT[section.kind])} />
                    {section.heading}
                    <span className="num font-medium text-ink-3">{section.rows.length}</span>
                  </h2>
                  <p className="text-small text-ink-3 max-sm:hidden">{section.explanation}</p>
                </div>
                {section.rows.map((row, i) => {
                  const isSelected = row.key === selected?.key;
                  const startsGroup =
                    row.kind === "approval" &&
                    row.invoiceApprovals > 1 &&
                    row.invoiceId !== null &&
                    section.rows[i - 1]?.invoiceId !== row.invoiceId;
                  return (
                    <Fragment key={row.key}>
                      {startsGroup && row.invoiceId ? (
                        <div className="col-span-full flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-2 sm:px-5">
                          <p className="text-small text-ink-2">
                            <span className="font-medium text-ink">{row.invoiceNumber}</span> for {row.clientName} ·{" "}
                            {row.invoiceApprovals} awaiting approval
                          </p>
                          <ApproveAllButton invoiceId={row.invoiceId} invoiceNumber={row.invoiceNumber ?? "this invoice"} count={row.invoiceApprovals} />
                        </div>
                      ) : null}
                      <ActionRow
                        client={row.clientName ?? row.title}
                        title={
                          <button
                            id={rowButtonId(row.key)}
                            type="button"
                            aria-current={isSelected ? "true" : undefined}
                            aria-expanded={isSelected && expanded ? true : undefined}
                            onClick={() => onRowClick(row.key)}
                            className="max-w-full cursor-pointer truncate text-left align-bottom text-ink-2 outline-none after:absolute after:inset-0 after:content-[''] hover:text-ink focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-focus focus-visible:after:outline-solid"
                          >
                            {row.line.title}
                          </button>
                        }
                        meta={row.line.meta}
                        amount={<MoneyList amounts={row.atStake} />}
                        actions={
                          hasQuickAction(row) && !(isSelected && expanded) ? <RowQuickAction row={row} /> : undefined
                        }
                        tone={row.kind === "failed" || row.kind === "bounce" ? "danger" : undefined}
                      />
                      {isSelected && expanded ? (
                        <div className="col-span-full border-b border-line bg-surface-2 xl:hidden">
                          <NeedsYouDetail key={row.key} row={row} inline />
                        </div>
                      ) : null}
                    </Fragment>
                  );
                })}
              </Fragment>
            ))}
          </ActionList>
        </div>
      </Card>

      <aside aria-label="Selected item" className="hidden xl:sticky xl:top-6 xl:block">
        <Card as="div" className="overflow-hidden">
          {selected ? <NeedsYouDetail key={selected.key} row={selected} /> : null}
        </Card>
      </aside>
    </div>
  );
}
