import { describe, expect, it } from "vitest";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MESSAGE_STATUS_META, MessageStatusBadge } from "@/components/status";
import { Switch } from "@/components/ui";
import {
  ActionList,
  ActionRow,
  AgingBar,
  EditableSection,
  Kbd,
  ProgressBar,
  ProgressRing,
  SegmentedTabs,
  StatTile,
  SummaryList,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Timeline,
  Tr,
  formatTimelineTime,
} from "@/components/data";

// createElement with children as rest arguments; typed loosely because TS cannot see
// rest children satisfying a required `children` prop.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const h = createElement as (type: any, props?: any, ...children: ReactNode[]) => ReactElement;
const html = (node: ReactElement) => renderToStaticMarkup(node);

// Anchors as { attrs, text }, independent of attribute order (next/link puts href last).
function anchors(markup: string) {
  return [...markup.matchAll(/<a ([^>]*)>(.*?)<\/a>/g)].map((m) => ({ attrs: m[1], text: m[2] }));
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function invoiceTable() {
  return h(
    Table,
    { label: "Overdue invoices" },
    h(THead, null, h(Th, null, "Invoice"), h(Th, { align: "right", sortHref: "?sort=amount", sorted: "desc" }, "Amount"), h(Th, null, "Due")),
    h(
      TBody,
      null,
      h(
        Tr,
        { href: "/invoices/inv_1", tone: "danger" },
        h(Td, { primary: true }, "PC-9002"),
        h(Td, { numeric: true, label: "Amount" }, "£2,720.00"),
        h(Td, { label: "Due" }, "3 Mar 2026"),
        h(Td, { label: "Next reminder" }, null),
      ),
      h(Tr, null, h(Td, { primary: true }, "PC-9003"), h(Td, { numeric: true, label: "Amount" }, "£10.00"), h(Td, { label: "Due" }, "4 Mar")),
    ),
  );
}

describe("Table", () => {
  const out = html(invoiceTable());

  it("has an sr-only caption with the label", () => {
    expect(out).toMatch(/<caption class="sr-only">Overdue invoices<\/caption>/);
  });

  it("wraps header cells in a row and hides the header on phone", () => {
    expect(out).toMatch(/<thead class="max-sm:hidden"><tr><th scope="col"/);
  });

  it("makes the whole row one keyboard-focusable link via the first cell", () => {
    const rows = out.split("<tr").slice(2); // skip "<table" split part and header row
    const linked = rows[0];
    expect(linked).toContain("data-row-link");
    expect(linked).toContain("relative");
    // exactly one anchor, in the first cell, stretched over the row
    expect(linked.match(/<a /g)?.length).toBe(1);
    expect(linked).toMatch(/^[^>]*><td[^>]*><a [^>]*>PC-9002<\/a><\/td>/);
    const [a] = anchors(linked);
    expect(a.attrs).toContain('href="/invoices/inv_1"');
    expect(a.attrs).toContain("data-row-anchor");
    expect(a.attrs).toContain("after:absolute after:inset-0");
    expect(a.attrs).toContain("focus-visible:after:outline-2");
    // a real <a href> is in the tab order without tabindex tricks
    expect(linked).not.toContain("tabindex");
    // the second row has no link
    expect(rows[1]).not.toContain("<a ");
    expect(rows[1]).not.toContain("data-row-link");
  });

  it("shows phone-only labels on secondary cells, not on primary ones", () => {
    expect(out).toContain('<span class="mr-1.5 text-ink-3 sm:hidden">Amount</span>£2,720.00');
    expect(out).toContain('<span class="mr-1.5 text-ink-3 sm:hidden">Due</span>3 Mar 2026');
    expect(out).not.toMatch(/sm:hidden">[^<]*<\/span>PC-9002/);
  });

  it("hides empty cells on phone so there are no blank label rows", () => {
    expect(out).toMatch(/<td class="[^"]*max-sm:hidden[^"]*"><span[^>]*>Next reminder<\/span><\/td>/);
  });

  it("marks tabular numeric cells and the sorted header", () => {
    expect(out).toMatch(/<td class="[^"]*num whitespace-nowrap[^"]*">/);
    expect(out).toContain('aria-sort="descending"');
    expect(anchors(out).some((a) => a.attrs.includes('href="?sort=amount"'))).toBe(true);
  });

  it("adds a left edge mark for toned rows", () => {
    expect(out).toContain("shadow-[inset_3px_0_0_var(--color-danger-fill)]");
  });

  it("does not double-wrap a header Tr", () => {
    const out2 = html(h(Table, { label: "x" }, h(THead, null, h(Tr, null, h(Th, null, "A"))), h(TBody, null)));
    expect(out2.match(/<tr/g)?.length).toBe(1);
  });
});

describe("AgingBar", () => {
  const out = html(
    h(AgingBar, {
      currency: "GBP",
      buckets: [
        { label: "Current", amountMinor: 100000, tone: "neutral" },
        { label: "1–30 days", amountMinor: 50050, tone: "warn" },
        { label: "31–60 days", amountMinor: 0, tone: "warn" },
        { label: "60+ days", amountMinor: 272000, tone: "danger" },
      ],
    }),
  );

  it("lists every bucket with its formatted amount in the legend", () => {
    expect(out).toContain("<dl");
    for (const [label, amount] of [
      ["Current", "£1,000.00"],
      ["1–30 days", "£500.50"],
      ["31–60 days", "£0.00"],
      ["60+ days", "£2,720.00"],
    ]) {
      expect(out).toMatch(new RegExp(`<dt[^>]*>(?:(?!</dt>).)*${escapeRe(label)}</span></dt><dd[^>]*><span class="num[^"]*">${escapeRe(amount)}</span></dd>`));
    }
  });

  it("draws one proportional segment per non-zero bucket and hides the bar from assistive tech", () => {
    expect(out).toMatch(/^<div[^>]*><div aria-hidden="true"/);
    expect(out.match(/flex-grow:\d+/g)).toEqual(["flex-grow:100000", "flex-grow:50050", "flex-grow:272000"]);
  });

  it("renders an empty track when everything is zero", () => {
    const empty = html(h(AgingBar, { currency: "USD", buckets: [{ label: "Current", amountMinor: 0, tone: "neutral" }] }));
    expect(empty).not.toContain("flex-grow");
    expect(empty).toContain("$0.00");
  });
});

describe("other primitives", () => {
  it("StatTile is a link when given href, with tabular value", () => {
    const out = html(h(StatTile, { label: "Overdue", value: "£2,720.00", sub: "4 invoices", tone: "danger", href: "/invoices?status=overdue" }));
    expect(out).toMatch(/^<a [^>]*href="\/invoices\?status=overdue"/);
    expect(out).toMatch(/class="num [^"]*text-danger[^"]*">£2,720\.00/);
    expect(out).toContain("4 invoices");
  });

  it("StatTile without href is not a link", () => {
    expect(html(h(StatTile, { label: "Overdue", value: "£0.00" }))).not.toContain("<a ");
  });

  it("SummaryList renders a definition list and says Not set for empty values", () => {
    const out = html(h(SummaryList, { items: [{ label: "Terms", value: "Net 30" }, { label: "PO number", value: null }] }));
    expect(out).toMatch(/<dl[^>]*><div[^>]*><dt[^>]*>Terms<\/dt><dd[^>]*>Net 30<\/dd><\/div>/);
    expect(out).toMatch(/<dt[^>]*>PO number<\/dt><dd[^>]*><span class="text-ink-3">Not set<\/span><\/dd>/);
  });

  it("SegmentedTabs marks the active tab and shows counts", () => {
    const out = html(
      h(SegmentedTabs, {
        label: "Invoice status",
        items: [
          { label: "All", href: "/invoices", count: 12, active: false },
          { label: "Overdue", href: "/invoices?status=overdue", count: 4, active: true },
        ],
      }),
    );
    expect(out).toMatch(/^<nav aria-label="Invoice status"/);
    const active = anchors(out).filter((a) => a.attrs.includes('aria-current="page"'));
    expect(active).toHaveLength(1);
    expect(active[0].attrs).toContain('href="/invoices?status=overdue"');
    expect(active[0].attrs).toMatch(/h-11[^"]*sm:h-8/);
    expect(out.match(/aria-current/g)?.length).toBe(1);
    expect(out).toMatch(/<span class="num[^"]*">12<\/span>/);
  });

  it("ActionRow links its title over the row and keeps actions above it", () => {
    const out = html(
      h(ActionRow, {
        href: "/needs-you/m1",
        client: "Acme Ltd",
        title: "Reminder 2 for PC-9002",
        meta: "Due 3 Mar",
        amount: "£2,720.00",
        status: "Failed",
        actions: h("button", { type: "button" }, "Retry"),
        tone: "danger",
      }),
    );
    expect(out).toContain("data-row-link");
    const [a] = anchors(out);
    expect(a.text).toBe("Reminder 2 for PC-9002");
    expect(a.attrs).toContain('href="/needs-you/m1"');
    expect(a.attrs).toContain("data-row-anchor");
    expect(out).toMatch(/<div class="relative z-\[1\][^"]*"><button type="button">Retry<\/button><\/div>/);
    expect(out).toContain(" · Due 3 Mar");
  });

  it("ActionRow without actions renders no actions slot", () => {
    const out = html(h(ActionRow, { client: "Acme", title: "Sent" }));
    expect(out).not.toContain("z-[1]");
    expect(out).not.toContain("<a ");
  });

  it("progress primitives expose progressbar semantics", () => {
    const ring = html(h(ProgressRing, { value: 3, max: 5, label: "Setup progress" }));
    expect(ring).toMatch(/role="progressbar" aria-label="Setup progress" aria-valuemin="0" aria-valuemax="5" aria-valuenow="3"/);
    expect(ring).toContain(">3/5</span>");
    const bar = html(h(ProgressBar, { value: 50, max: 150, label: "Paid" }));
    expect(bar).toMatch(/role="progressbar" aria-label="Paid"[^>]*aria-valuenow="50"/);
    expect(bar).toContain(">33%</span>");
    expect(bar).toContain("width:33.33");
  });

  it("ProgressBar clamps and survives a zero max", () => {
    expect(html(h(ProgressBar, { value: 5, max: 0, label: "x" }))).toContain("width:0%");
    expect(html(h(ProgressBar, { value: 9, max: 3, label: "x" }))).toContain("width:100%");
  });

  it("Timeline uses one time format in the given zone and an ordered list", () => {
    const out = html(
      h(Timeline, {
        zone: "Europe/London",
        items: [
          { at: "2026-03-12T14:05:00Z", title: "Reminder sent", detail: "To ap@acme.test", tone: "ok" },
          { at: "2026-07-01T09:00:00Z", title: "Invoice created" },
        ],
      }),
    );
    expect(out).toMatch(/^<ol/);
    expect(out).toContain('<time dateTime="2026-03-12T14:05:00Z"');
    expect(out).toContain("12 Mar 2026, 2:05 PM");
    expect(out).toContain("1 Jul 2026, 10:00 AM"); // BST
    expect(out).toContain("To ap@acme.test");
    expect(formatTimelineTime("yesterday")).toBe("yesterday");
  });

  it("Kbd renders a kbd element", () => {
    expect(html(h(Kbd, null, "J"))).toMatch(/^<kbd[^>]*>J<\/kbd>$/);
  });

  it("EditableSection renders the summary and a labelled Edit button, not the form", () => {
    const out = html(
      h(EditableSection, { title: "Payment terms", summary: h("p", null, "Net 30") }, h("form", null, h("input", { name: "terms" }))),
    );
    expect(out).toMatch(/<section aria-labelledby="([^"]+)"[^>]*>.*<h2 id="\1"[^>]*>Payment terms<\/h2>/);
    expect(out).toMatch(/<button[^>]*aria-expanded="false"[^>]*>Edit<span class="sr-only"> Payment terms<\/span><\/button>/);
    expect(out).toContain("<p>Net 30</p>");
    expect(out).not.toContain("<form");
  });

  it("ActionList groups rows so desktop columns line up (subgrid hook)", () => {
    const out = html(h(ActionList, { label: "Needs you" }, h(ActionRow, { client: "A", title: "x" }), h(ActionRow, { client: "B", title: "y" })));
    expect(out).toMatch(/^<div data-action-list="" role="group" aria-label="Needs you">/);
    expect(out.match(/data-action-row=""/g)?.length).toBe(2);
  });
});

describe("status tones and Switch", () => {
  it("Scheduled is neutral; Sent and Delivered are success; info is not used for them", () => {
    expect(MESSAGE_STATUS_META.scheduled.tone).toBe("neutral");
    expect(MESSAGE_STATUS_META.sent.tone).toBe("ok");
    expect(MESSAGE_STATUS_META.delivered.tone).toBe("ok");
    expect(html(h(MessageStatusBadge, { status: "delivered" }))).toContain("<svg");
    expect(html(h(MessageStatusBadge, { status: "sent" }))).not.toContain("<svg");
  });

  it("Switch has a 44px row, a stretched label, a 3:1 off border and a described input", () => {
    const out = html(h(Switch, { id: "auto", label: "Auto-send", description: "Send without asking." }));
    expect(out).toMatch(/^<div class="relative flex min-h-11/);
    expect(out).toMatch(/<label for="auto" class="[^"]*after:absolute after:inset-0/);
    expect(out).toContain("border-control-border");
    expect(out).toMatch(/role="switch"[^>]*aria-describedby="auto-desc"/);
  });
});
