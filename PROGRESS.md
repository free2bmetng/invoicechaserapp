# Invoice Chaser: build progress and contracts

Spec: /tmp/claude-0/-home-user/7b6e5336-0034-53ba-92ee-42280989f471/scratchpad/rewritten-prompt.txt
Run tests: `npm test` (needs Postgres on localhost:5433; see tests/helpers/env.ts).
Typecheck: `npm run typecheck`.

## Decisions taken (spec was silent or ambiguous)
- Auth: built-in magic link + session cookie, not Supabase Auth, because no Supabase credentials exist. Interface is isolated in src/lib/auth.ts so Supabase Auth can replace it. Recorded as a deviation.
- Stripe: restricted key, pasted by the user, stored encrypted in connected_accounts. Recorded.
- Transactional email: Resend chosen for v1. Postmark stub type only.
- planned_at = (due_date + offset_days) at the client's send-window start (09:00 local), then deferred to the window if needed.
- CC contacts: included as CC on the message. Holds apply to the primary contact address. A held CC is dropped from that send, not the whole message.
- Installments reuse the plan sequence; default plan sequence = one step at offset 0 per installment.
- Duplicate invoice (same user, client email, invoice_number) is rejected at import.

## Module ownership (one owner per file; do not edit another owner's files)
- ENGINE (agent "engine"): src/lib/engine/**, tests/engine/**
- CONTENT (agent "content"): src/lib/money.ts, src/lib/templates.ts, src/lib/csv.ts, src/lib/crypto.ts, src/lib/export.ts, src/lib/formulas.ts, tests/content/**
- INTEGRATIONS (agent "integrations"): src/lib/providers/{resend,stripe,factory}.ts, src/lib/auth.ts, src/app/api/webhooks/**, src/app/api/cron/**, tests/integrations/**
- SHARED (lead, already written): src/lib/{db,clock,types}.ts, src/lib/providers/{types,fake}.ts, db/migrations/**, tests/helpers/**
- UI (later): src/app/** (except api/), src/components/**, src/app/globals.css

## Contracts

### content: src/lib/money.ts
- parseMoneyToMinor(input: string, currency: string): number  // "1234.5" USD -> 123450; throws on bad input
- formatMoney(minor: number, currency: string, locale?: string): string  // Intl-based

### content: src/lib/templates.ts
- TONE_PRESETS: Record<"friendly"|"neutral"|"firm", {subject: string; body: string}>  // no legal/fee/interest threats
- validateTemplate(input: {subject: string; body: string}, opts?: {preset?: boolean}): {ok: true} | {ok: false; errors: string[]}
  // rejects unknown {tokens}; preset=true also rejects legal/fee/interest/collections wording
- FOOTER_LINES(sender: {senderName; businessName; postalAddress}): string
- buildMessage(args: {
    template: {subject: string; body: string};
    context: { clientName; invoiceNumber; amountMinor: number; currency; dueDate: Date | string; daysOverdue: number; senderName; businessName; timezone: string; payLink: string | null };
    stripeConnected: boolean;
    sender: {senderName; businessName; postalAddress};
  }): {subject: string; text: string}
  // pay_link rules: link present + no token -> link line added before footer; link null -> lines containing {pay_link} removed.
  // stripeConnected && payLink == null -> throws PayLinkRequiredError (caller marks the row failed).

### content: src/lib/csv.ts
- INVOICE_CSV_HEADERS = ["client_name","client_email","invoice_number","amount","currency","issue_date","due_date"]
- MAX_IMPORT_ROWS = 5000
- planCsvImport(text: string, existingKeys: Set<string>  /* key = `${client_email}|${invoice_number}` */, today: string /* YYYY-MM-DD */):
    {headerErrors: string[]; valid: ImportRow[]; rejected: Array<{line: number; reasons: string[]; raw: Record<string,string>}>; duplicates: number}
  type ImportRow = {line; clientName; clientEmail; invoiceNumber; amountMinor; currency; issueDate; dueDate}

### content: src/lib/crypto.ts
- encryptSecret(plain: string): string   // base64(iv):base64(tag):base64(ct), AES-256-GCM, key from ENCRYPTION_KEY
- decryptSecret(cipher: string): string  // throws on tamper

### content: src/lib/formulas.ts
- csvSafeCell(value: string): string     // prefixes ' when value starts with = + - @ tab or CR

### content: src/lib/export.ts
- exportUserData(userId: string): Promise<Uint8Array>  // zip of CSVs (one per table, via withUser); never includes secrets

### engine: src/lib/engine/index.ts (public API; everything else is internal)
- type SenderDeps = { clock: Clock; appUrl: string; emailFor(userId: string): Promise<EmailProvider>; paymentsFor(userId: string): Promise<PaymentProvider | null> }
- runSender(deps: SenderDeps, opts?: {batchSize?: number}): Promise<{claimed: number; sent: number; deferred: number; cancelled: number; held: number; failed: number; needsCheck: number}>
- setInvoiceStatus(userId: string, invoiceId: string, status: InvoiceStatus, clock: Clock): Promise<void>  // applies 3.4 stop + resume; resume when moving to open/payment_plan
- recordPayment(args: {userId; invoiceId; installmentId: string | null; paidAt: Date; source: "stripe"|"manual"; clock: Clock}): Promise<void>
- recordBounce(args: {provider: string; providerMessageId: string; clock: Clock}): Promise<void>   // looks up message_log, holds address rows across that user's invoices
- recordDeliveryStatus(args: {provider: string; providerMessageId: string; status: "delivered"|"bounced"|"failed"; clock: Clock}): Promise<void>
- recordReply(args: {userId; clientId; clock: Clock}): Promise<void>
- planInvoice(userId: string, invoiceId: string, clock: Clock): Promise<void>  // (re)plans unsent rows; skips past steps
- approveMessage(userId, messageId, clock), editMessage(userId, messageId, {subject?, body?}, clock), holdMessage(...), resumeMessage(...), cancelMessage(...), retryFailed(...), resolveNeedsCheck(userId, messageId, "sent"|"skipped", clock)
- resumeContact(userId, contactId, clock), resumeClient(userId, clientId, clock)

### integrations: src/lib/providers/factory.ts
- emailFor(userId): Promise<EmailProvider>   // fake unless SEND_ENABLED=true and settings.sending_provider set
- paymentsFor(userId): Promise<PaymentProvider | null>   // null when no Stripe key connected

### integrations: src/lib/auth.ts
- requestMagicLink(email: string, clock: Clock): Promise<{devLink?: string}>   // devLink only when SEND_ENABLED is not true
- consumeMagicLink(token: string, clock: Clock): Promise<{sessionToken: string; userId: string}>
- currentUserId(sessionToken: string | undefined, clock: Clock): Promise<string | null>
- endSession(sessionToken: string): Promise<void>

### integrations: routes
- POST /api/cron/send  (Authorization: Bearer CRON_SECRET) -> runSender(...)
- POST /api/webhooks/provider  (header x-webhook-signature = hex HMAC-SHA256(body, PROVIDER_WEBHOOK_SECRET)) -> recordDeliveryStatus / recordBounce
- POST /api/webhooks/stripe/[token]  (Stripe-Signature verified with that connection's own secret, stored encrypted) -> dedupe stripe_events, recordPayment on paid checkout sessions. Superseded STRIPE_WEBHOOK_SECRET design.

## Status board
- [x] Scaffold, Postgres 16 local cluster, RLS verified, migration 0001, test harness, smoke test
- [x] content (230 tests passing, verified)  - [ ] engine  - [x] integrations (stub-verified; real-engine run pending)  - [ ] UI  - [ ] critic loop  - [ ] blind comparison

## Decisions added after integrations report
- Stripe webhooks: one endpoint per connected account. Route is /api/webhooks/stripe/[token]. Each connection has its own signing secret, stored encrypted (migration 0002). The single STRIPE_WEBHOOK_SECRET design was dropped because Stripe signs each endpoint with its own secret.
- SEND_ENABLED=true selects Resend. settings.sending_provider is not consulted in v1, because only Resend is supported. Other providers are out of scope.
- Dev magic-link URL is returned only when SEND_ENABLED is not true and NODE_ENV is not production. In production with sending off, requestMagicLink throws AuthNotConfiguredError.
- provisionUser(userId, clock) is idempotent and runs on every sign-in.
- Crons: vercel.json schedules /api/cron/send every 5 minutes. Vercel's Hobby plan allows only daily crons, so the README must document the plan requirement.
- Migration 0002 is applied to dev, test and per-agent databases.

## Status update (lead)
- engine: complete, 209 tests passing, public API in src/lib/engine/index.ts (writes: createClient, updateClient, upsertContact, removeContact, createInvoice, updateInvoice, setInvoiceContacts, importInvoices, saveSequence, planOpenInvoices; reads: listInvoices, listClients, getInvoiceDetail, getClientDetail, listSequences).
- integrations: complete, 136 tests passing, includes digest (src/lib/digest.ts, called from the cron route after runSender).
- content: complete, 230 tests passing.
- shell: complete (src/app/(app)/layout.tsx, src/components/shell/**, src/lib/session.ts), production build passes.
- UI in progress: ops (sign-in, dashboard, needs-you, next-7-days, messages, seed), settings (settings, Stripe connect, onboarding, export, deletion), records (invoices, clients, import, sequences).
- Not started: visual critic loop, blind comparison, final build and end-to-end checks.

## Status update (lead, after the usage-limit reset)
- Database: the project cluster now runs on port 5433. A system Postgres service took port 5432 after the worker restart and requires passwords. All env files and tests/helpers/env.ts point at 5433.
- Verified suites: content 230, engine 209 (re-checking after the onboarding gate), integrations 136, settings 114. Operations has 78 of 80 passing, and the 2 failures are test-fixture bugs routed back to its owner.
- Decisions: skipped rows left by setPaymentPlan are terminal and never sent, so acceptance item 5 means no unsent or dispatched default-sequence rows. Cancelling the held reminders of a reply hold leaves the client on hold until resumeClient, by design. Planning is gated on onboarding_done, per spec 3.8.
- Records (invoices, clients, import, sequences): still in progress.

## Visual critic round 1 (lead)
- Records (invoices, clients, import, sequences): FAIL. 24 fixes dispatched to the records builder.
- Settings: FAIL. Section index, DNS value wrapping and onboarding details dispatched.
- Operations (dashboard, needs-you, next-7-days, messages, login): FAIL. 13 fixes dispatched.
- Shared: primitives moved to 44px tap targets on phone (Button, Input). Typecheck clean, static guards 7 of 7.
- Capture tool reuses a saved session per email (scratchpad/session-<email>.json), so sign-in rate limits are not hit.
- Iteration cap: three critic rounds. Round 2 starts when the fixes report back.

## Final state (lead)
- Typecheck: clean. Production build (`next build`): passes.
- Tests: content 230, engine 236, integrations 136, settings 113, ops 82, records 87. Total 884, all passing.
- Visual critic: three rounds, then final fixes. No page reached 9 with no blockers in a final critic round.
- Blind comparison, two runs: our dashboard scored 7.3 in both, against Chaser's public homepage at 6.5 and 6.7. Both are within the one-point margin, and both compare an app screen with a marketing page.
- Open critic findings (not fixed): skipped reminders on invoice detail have no reason; unknown IDs return a stock 404 with HTTP 200; sequence editor sticky bar covers step 1's Preview on phone; settings Save placement contradicts the "one Save per section" claim; invoices strip mixes currencies without labels; several phone targets are under 44px.
- Not done: deployment (no credentials), live Stripe and email calls, Supabase Auth (magic link used instead), an end-to-end browser test suite, and review of the late-payment terms text by a lawyer.

## Decisions (lead, after the owner's review)
- Sign-in: passkeys for everyday use (discoverable credentials, user verification required), magic link as fallback for new devices. Sessions are 90 days, sliding. Migration 0004 adds passkeys and webauthn_challenges. Built by the passkey agent.
- Stripe: OAuth (Stripe Connect). Restricted-key path kept only for internal testing. Integrations and settings are building it. Needs the Connect client ID and platform webhook setup before live testing.
- Days to pay: headline is "typically pays X days late", from the due date. Negative means early. Issue-date figure kept as secondary.
- Payment on a disputed or written-off invoice: marked paid, with a Needs you item to confirm the dispute is resolved. Engine builder.
- Installments: new plans get reminders at -3, 0 and +7 per installment. The +7 only sends if the installment is still unpaid. Existing plans unchanged.
- Reminders are transactional only. Stop-line wording pending owner approval.
- Backups: managed Postgres with daily backups and point-in-time recovery, 7 to 30 days retention, privacy policy states backups purge within that window, restore tested before launch.
- Local Postgres: the sandbox restarts and does not restart the project cluster on port 5433. Restart it with pg_ctl before tests or the app.
