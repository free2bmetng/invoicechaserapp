// Demo account for Invoice Chaser. Run with: npx tsx scripts/seed.ts
//
// It builds one complete account through the real engine, with fake providers: a sender
// profile, clients with contacts, invoices in every status, one payment plan, and the queue
// states the screens show (approvals, a bounce, a reply, a failed send, a delivery check).
// Nothing is sent and no Stripe call is made.
//
// Every action runs on its own fixed clock, in time order, so each history event carries its
// own time. The times are offsets from today in the demo zone: the account opens a week ago,
// invoices and status changes follow over the next few days, and the first reminders go out
// at 10:00 today.
//
// Needs DATABASE_ADMIN_URL (demo user and profile setup) and DATABASE_URL and
// DATABASE_SERVICE_URL (engine). Safe to run twice: the demo user is deleted, with all of
// its rows, and rebuilt. Refuses to run when SEND_ENABLED=true or NODE_ENV=production.
import { Client, type QueryResultRow } from "pg";
import { DateTime } from "luxon";
import {
  approveMessage,
  createClient,
  createInvoice,
  holdMessage,
  provisionUser,
  recordBounce,
  recordPayment,
  recordReply,
  runSender,
  setInvoiceStatus,
  setPaymentPlan,
  upsertContact,
} from "@/lib/engine";
import { fixedClock, type Clock } from "@/lib/clock";
import { closeDb } from "@/lib/db";
import { parseMoneyToMinor } from "@/lib/money";
import { FakeEmailProvider } from "@/lib/providers/fake";
import {
  ProviderAmbiguousError,
  ProviderRefusedError,
  type OutgoingEmail,
  type SendResult,
} from "@/lib/providers/types";

export const DEMO_EMAIL = "demo@invoicechaser.test";
export const DEMO_ZONE = "Europe/London";

const SENDER = {
  senderName: "Maya Okafor",
  businessName: "Okafor Studio",
  postalAddress: "14 Canal Street, Manchester M1 3HE, United Kingdom",
};

// Fake email that refuses or times out for chosen recipients, to produce the failure
// states. Everything else is accepted by the normal fake provider.
class ScriptedEmailProvider extends FakeEmailProvider {
  constructor(
    private readonly refuse: ReadonlySet<string>,
    private readonly ambiguous: ReadonlySet<string>,
  ) {
    super();
  }

  override async send(email: OutgoingEmail): Promise<SendResult> {
    const to = email.to.toLowerCase();
    if (this.refuse.has(to)) {
      this.calls.push(email);
      throw new ProviderRefusedError("scripted refusal for the demo");
    }
    if (this.ambiguous.has(to)) {
      this.calls.push(email);
      throw new ProviderAmbiguousError("scripted timeout for the demo");
    }
    return super.send(email);
  }
}

export interface SeedSummary {
  userId: string;
  email: string;
  clients: number;
  invoices: number;
  scheduledMessages: Record<string, number>;
  messagesSent: number;
}

function assertSafeToRun(): void {
  if (process.env.SEND_ENABLED === "true") {
    throw new Error("Refusing to seed: SEND_ENABLED=true. The demo must never send real email.");
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed: NODE_ENV is production.");
  }
  for (const name of ["DATABASE_ADMIN_URL", "DATABASE_URL", "DATABASE_SERVICE_URL"]) {
    if (!process.env[name]) throw new Error(`${name} is required to seed the demo account.`);
  }
}

interface InvoiceSpec {
  clock: Clock;
  clientId: string;
  number: string;
  amount: string;
  currency: string;
  // Days from today for the issue and due dates.
  issue: number;
  due: number;
  contacts?: { primaryContactId: string; ccContactIds: string[] };
}

// Builds the demo account. The log callback receives progress lines.
export async function seedDemo(log: (line: string) => void = () => undefined): Promise<SeedSummary> {
  assertSafeToRun();
  const db = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await db.connect();
  try {
    // Offsets are days from today in the demo zone. clockOn returns a fixed clock for one
    // moment, so each action records its own event time.
    const today = DateTime.now().setZone(DEMO_ZONE).startOf("day");
    const day = (offset: number) => today.plus({ days: offset }).toISODate() ?? "";
    const clockOn = (offset: number, hour: number, minute = 0) =>
      fixedClock(today.plus({ days: offset }).set({ hour, minute }).toJSDate().toISOString());
    // The first reminders go out at 10:00 today, inside the send window. The bounce follows.
    const sendClock = clockOn(0, 10, 0);
    const bounceClock = clockOn(0, 10, 20);

    await db.query("delete from users where email = $1", [DEMO_EMAIL]);
    const created = await db.query<{ id: string }>("insert into users (email) values ($1) returning id", [DEMO_EMAIL]);
    const userId = created.rows[0].id;
    await provisionUser(userId, clockOn(-7, 8, 50));
    // Setup, not engine state: the sender profile, onboarding done and a placeholder sending
    // domain are written together, before any invoice is planned.
    await db.query(
      `update settings set sender_name = $2, business_name = $3, postal_address = $4, timezone = $5,
         sending_domain = 'mail.invoicechaser.test', onboarding_done = true, daily_cap = 20,
         send_window_start = 9, send_window_end = 17, digest_hour = 8, digest_enabled = true
       where user_id = $1`,
      [userId, SENDER.senderName, SENDER.businessName, SENDER.postalAddress, DEMO_ZONE],
    );
    log("Demo user and sender profile ready.");

    // ---- Clients and contacts, created in the first minutes of the account ----------
    const client = (minute: number, name: string, email: string, autoSend: boolean) =>
      createClient(userId, { name, email, autoSend }, clockOn(-7, 9, minute));
    const northwind = await client(0, "Northwind Architects", "accounts@northwind.test", true);
    const northwindFinance = await upsertContact(
      userId,
      northwind.clientId,
      { email: "finance@northwind.test", name: "Finance", isPrimary: false },
      clockOn(-7, 9, 1),
    );
    const bluebird = await client(2, "Bluebird Design", "hello@bluebird.test", false);
    const harbour = await client(3, "Harbour & Co", "billing@harbour.test", false);
    const quill = await client(4, "Quill Labs", "ap@quilllabs.test", true);
    const maple = await client(5, "Maple Print", "maple@mapleprint.test", true);
    const orion = await client(6, "Orion Logistics", "payables@orion.test", true);
    const lantern = await client(7, "Lantern Books", "finance@lanternbooks.test", true);
    const tidewater = await client(8, "Tidewater Consulting", "ops@tidewater.test", false);
    const papercrane = await client(9, "Paper Crane Studio", "accounts@papercrane.test", true);
    log("Clients and contacts created.");

    // Each invoice is created at its own moment. The creation time decides which of its steps are
    // already past, so the timeline below keeps the planned reminders the demo relies on.
    const invoice = (spec: InvoiceSpec) =>
      createInvoice(
        userId,
        {
          clientId: spec.clientId,
          invoiceNumber: spec.number,
          amountMinor: parseMoneyToMinor(spec.amount, spec.currency),
          currency: spec.currency,
          issueDate: day(spec.issue),
          dueDate: day(spec.due),
          contacts: spec.contacts,
        },
        spec.clock,
      ).then((r) => r.invoiceId);

    // ---- Day -6: older invoices, and Paper Crane's invoices in each remaining status --
    await invoice({ clock: clockOn(-6, 9, 0), clientId: harbour.clientId, number: "HC-3002", amount: "420.00", currency: "GBP", issue: -70, due: -45 });
    const bb2001 = await invoice({ clock: clockOn(-6, 10, 0), clientId: bluebird.clientId, number: "BB-2001", amount: "2300.00", currency: "GBP", issue: -40, due: -7 });
    const pc9004 = await invoice({ clock: clockOn(-6, 11, 0), clientId: papercrane.clientId, number: "PC-9004", amount: "300.00", currency: "USD", issue: -120, due: -90 });
    await setInvoiceStatus(userId, pc9004, "written_off", clockOn(-6, 11, 5));
    const pc9003 = await invoice({ clock: clockOn(-6, 11, 10), clientId: papercrane.clientId, number: "PC-9003", amount: "2400.00", currency: "USD", issue: -100, due: -70 });
    await setInvoiceStatus(userId, pc9003, "paused", clockOn(-6, 11, 15));
    const pc9002 = await invoice({ clock: clockOn(-6, 11, 20), clientId: papercrane.clientId, number: "PC-9002", amount: "890.00", currency: "USD", issue: -40, due: -10 });
    const pc9001 = await invoice({ clock: clockOn(-6, 11, 30), clientId: papercrane.clientId, number: "PC-9001", amount: "1500.00", currency: "USD", issue: -60, due: -30 });

    // ---- Day -5: a dispute, and the payment that was received on day -20 but recorded now ----
    await setInvoiceStatus(userId, pc9002, "disputed", clockOn(-5, 9, 0));
    await recordPayment({
      userId,
      invoiceId: pc9001,
      installmentId: null,
      paidAt: today.plus({ days: -20 }).set({ hour: 14 }).toJSDate(),
      source: "manual",
      clock: clockOn(-5, 16, 0),
    });

    // ---- Day -3: invoices due today, and Tidewater's invoice for its payment plan -------
    await invoice({
      clock: clockOn(-3, 10, 0),
      clientId: northwind.clientId,
      number: "NW-1001",
      amount: "4800.00",
      currency: "USD",
      issue: -30,
      due: 0,
      contacts: { primaryContactId: northwind.contactId, ccContactIds: [northwindFinance.contactId] },
    });
    await invoice({ clock: clockOn(-3, 10, 10), clientId: maple.clientId, number: "MP-5001", amount: "640.00", currency: "USD", issue: -30, due: 0 });
    await invoice({ clock: clockOn(-3, 10, 20), clientId: orion.clientId, number: "OR-6001", amount: "2075.00", currency: "USD", issue: -20, due: 0 });
    await invoice({ clock: clockOn(-3, 10, 30), clientId: lantern.clientId, number: "LB-7001", amount: "1140.00", currency: "GBP", issue: -14, due: 0 });
    const tw8001 = await invoice({ clock: clockOn(-3, 13, 0), clientId: tidewater.clientId, number: "TW-8001", amount: "3000.00", currency: "EUR", issue: -30, due: 5 });

    // ---- Day -2: the rest of the open invoices, and the payment plan --------------------
    await invoice({ clock: clockOn(-2, 9, 0), clientId: northwind.clientId, number: "NW-1002", amount: "1250.00", currency: "USD", issue: -20, due: 3 });
    await invoice({ clock: clockOn(-2, 9, 10), clientId: northwind.clientId, number: "NW-1003", amount: "760.00", currency: "USD", issue: -5, due: 10 });
    const nw1004 = await invoice({ clock: clockOn(-2, 9, 20), clientId: northwind.clientId, number: "NW-1004", amount: "500.00", currency: "USD", issue: -26, due: 4 });
    await invoice({ clock: clockOn(-2, 9, 30), clientId: harbour.clientId, number: "HC-3001", amount: "1850.00", currency: "GBP", issue: -10, due: 4 });
    await invoice({ clock: clockOn(-2, 9, 40), clientId: maple.clientId, number: "MP-5002", amount: "980.00", currency: "USD", issue: -12, due: 6 });
    await setPaymentPlan(
      userId,
      tw8001,
      [
        { dueDate: day(5), amountMinor: parseMoneyToMinor("1000.00", "EUR") },
        { dueDate: day(35), amountMinor: parseMoneyToMinor("1000.00", "EUR") },
        { dueDate: day(65), amountMinor: parseMoneyToMinor("1000.00", "EUR") },
      ],
      clockOn(-2, 14, 0),
    );

    // ---- Day -1: a new client, an approval, a reply and a hold, all before the first run --
    await invoice({ clock: clockOn(-1, 9, 30), clientId: quill.clientId, number: "QL-4001", amount: "3100.00", currency: "EUR", issue: -28, due: 2 });
    const bluebirdStep = await one(db, userId, bb2001, 7, "pending_approval");
    if (bluebirdStep) await approveMessage(userId, bluebirdStep, clockOn(-1, 15, 0));
    await recordReply({ userId, clientId: quill.clientId, clock: clockOn(-1, 16, 0) });
    const held = await one(db, userId, nw1004, -3, "scheduled");
    if (held) await holdMessage(userId, held, clockOn(-1, 16, 30));
    log("Invoices, status changes, the payment plan, the approval, the reply and the hold recorded.");

    // ---- Day 0, 10:00: the first sender run, with scripted provider outcomes -----------
    const email = new ScriptedEmailProvider(new Set(["payables@orion.test"]), new Set(["finance@lanternbooks.test"]));
    const run = await runSender(
      {
        clock: sendClock,
        appUrl: process.env.APP_URL ?? "http://localhost:3000",
        emailFor: async () => email,
        paymentsFor: async () => null,
      },
      {},
    );
    log(`First run: ${run.sent} sent, ${run.failed} failed, ${run.needsCheck} need a check.`);

    // ---- Day 0, 10:20: the provider reports a bounce for Maple's first reminder --------
    const mapleLog = await db.query<{ provider_message_id: string | null }>(
      `select l.provider_message_id from message_log l join invoices i on i.id = l.invoice_id
        where l.user_id = $1 and i.invoice_number = 'MP-5001' order by l.sent_at limit 1`,
      [userId],
    );
    const bouncedId = mapleLog.rows[0]?.provider_message_id;
    if (bouncedId) await recordBounce({ provider: "fake", providerMessageId: bouncedId, clock: bounceClock });
    log("Bounce recorded.");

    // ---- Summary ---------------------------------------------------------------
    const statuses = await db.query<{ status: string; n: string }>(
      "select status, count(*)::text as n from scheduled_messages where user_id = $1 group by status order by status",
      [userId],
    );
    const sent = await db.query<{ n: string }>("select count(*)::text as n from message_log where user_id = $1", [userId]);
    const counts = await db.query<{ clients: string; invoices: string }>(
      "select (select count(*)::text from clients where user_id = $1) as clients, (select count(*)::text from invoices where user_id = $1) as invoices",
      [userId],
    );
    return {
      userId,
      email: DEMO_EMAIL,
      clients: Number(counts.rows[0].clients),
      invoices: Number(counts.rows[0].invoices),
      scheduledMessages: Object.fromEntries(statuses.rows.map((r) => [r.status, Number(r.n)])),
      messagesSent: Number(sent.rows[0].n),
    };
  } finally {
    await db.end();
    await closeDb();
  }
}

// The one message on an invoice at a given offset and status, or null.
async function one(db: Client, userId: string, invoiceId: string, offset: number, status: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string } & QueryResultRow>(
    `select m.id from scheduled_messages m join sequence_steps st on st.id = m.step_id
      where m.user_id = $1 and m.invoice_id = $2 and st.offset_days = $3 and m.status = $4
      order by m.planned_at limit 1`,
    [userId, invoiceId, offset, status],
  );
  return rows[0]?.id ?? null;
}

async function main() {
  const summary = await seedDemo((line) => console.log(line));
  console.log(`Seeded ${summary.email}: ${summary.clients} clients, ${summary.invoices} invoices, ${summary.messagesSent} messages sent.`);
  console.log("Scheduled messages by status:", summary.scheduledMessages);
  console.log("Sign in at /login with this address. In development, the sign-in link is shown on the page.");
}

// Runs only when this file is the entry point, so tests can import seedDemo safely.
if (process.argv[1] && /seed\.(ts|js)$/.test(process.argv[1])) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
