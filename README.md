# Invoice Chaser

Invoice Chaser helps freelancers and small service businesses get paid on time. It sends calm, transactional follow-up reminders for overdue invoices. Each reminder is previewed, approved and logged. The account holder decides what goes out, and the app never holds or routes money.

Built with Next.js 16 (App Router, `cacheComponents`), TypeScript, Postgres with row-level security, Stripe Connect, and Resend.

## What it does

- **Invoices:** add by hand, or import a CSV of up to 5,000 rows, with a preview before anything is saved.
- **Sequences:** reminder steps relative to the due date, with a live preview that never creates a payment link.
- **Approvals:** the first message to a new client, and any step flagged for approval, waits under Needs you.
- **Stop rules:** paying, pausing, disputing or writing off an invoice cancels its unsent reminders. A bounce or a reply holds that address or client.
- **Payments:** Stripe Payment Links are created per payable, and money settles directly into the user's Stripe account.
- **Digest:** one daily email, sent only when there is something to report.
- **Account:** passkey sign-in with an email-link fallback, data export, and account deletion.

## Requirements

- Node.js 22 or later
- Postgres 16 (Supabase, the Vercel Marketplace, or a local server)
- A Resend account and a verified sending domain, for real email
- A Stripe account with Connect, for payments

## Local setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a Postgres database, and two roles on it. Replace the passwords:

   ```sql
   create role app_rls login password 'CHANGE_ME' nosuperuser nobypassrls;
   create role app_service login password 'CHANGE_ME' nosuperuser bypassrls;
   ```

   `app_rls` is the request role. Row-level security applies to it. `app_service` is used only by the sender cron and the webhooks, and every query it runs must filter by user.

3. Copy `.env.example` to `.env.local` and fill in the values. Never commit real values. See [Environment variables](#environment-variables).

4. Apply the migrations with the admin (owner) connection:

   ```bash
   DATABASE_ADMIN_URL=postgres://owner@host:5432/invoice_chaser npm run db:migrate
   ```

   Migrations `0001` to `0006` apply in order, and each one runs once.

5. Start the app:

   ```bash
   npm run dev
   ```

   Open http://localhost:3000/login. In development, the sign-in link appears on the page, so you don't need email set up.

### Demo account

```bash
npx tsx scripts/seed.ts
```

The seed creates `demo@invoicechaser.test` with clients, invoices in every status, a payment plan, approvals, holds and a sent history spread over the past week. It is safe to run twice, because it rebuilds the demo user each time. It refuses to run when `SEND_ENABLED=true` or `NODE_ENV=production`, and it never sends real email.

## Environment variables

Names only. Values belong in `.env.local` or your host's secret store.

| Name | Purpose |
| --- | --- |
| `DATABASE_URL` | Request connection, as the `app_rls` role. |
| `DATABASE_SERVICE_URL` | Cron and webhook connection, as the `app_service` role. |
| `DATABASE_ADMIN_URL` | Owner connection, used only for migrations and the seed. |
| `ENCRYPTION_KEY` | 32 random bytes, base64-encoded. Encrypts stored secrets. Losing it makes stored secrets unreadable. Generate with `openssl rand -base64 32`. |
| `CRON_SECRET` | Bearer token that protects `/api/cron/send`. |
| `PROVIDER_WEBHOOK_SECRET` | Signs inbound delivery webhooks from the email provider. |
| `APP_URL` | Public origin, for example `https://app.example.com`. Also the passkey relying-party host. |
| `SEND_ENABLED` | `true` to send real email and create real payment links. Off by default. |
| `RESEND_API_KEY` | Resend API key. Used only when `SEND_ENABLED=true`. |
| `AUTH_EMAIL_FROM` | From address for sign-in emails, on your verified domain. |
| `STRIPE_CONNECT_CLIENT_ID` | Stripe Connect client ID (`ca_…`). |
| `STRIPE_SECRET_KEY` | Platform secret key (`sk_…`). Server-side only. |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | Signing secret of the platform webhook endpoint. |
| `STRIPE_KEY_MODE` | Leave unset in production. `restricted` allows pasting a restricted key, for internal testing only. |
| `NODE_ENV` | `production` in deployment. In production, development sign-in links are never shown. |

## Testing

```bash
npm run typecheck
npm test
```

The tests need a reachable Postgres. The connection settings are in `tests/helpers/env.ts`, which names one database per suite through `TEST_DB_NAME` (default `invoice_chaser_test`). Edit that file if your Postgres runs somewhere else. Each database needs the migrations applied, with the same roles as above. The tests use fake email and payment providers, and they never call Stripe or Resend.

## Deployment

The app is a standard Next.js build. The steps below use Vercel and a managed Postgres database.

1. **Database.** Create a Postgres database. Create the `app_rls` and `app_service` roles as above, with strong passwords. Apply the migrations with the owner connection.
2. **Project.** Import the repository into Vercel. Set every variable in the table above for the Production environment. Set `NODE_ENV=production` and `APP_URL` to the public address.
3. **Sending domain.** Verify your sending domain in Resend and publish the DNS records it gives you. See [Sending domain](#sending-domain). Then set `SEND_ENABLED=true`.
4. **Stripe.** Create a Connect application. Register `APP_URL/api/stripe/callback` as a redirect URI. Create a platform webhook endpoint at `APP_URL/api/webhooks/stripe` that receives connected-account events, with `checkout.session.completed` enabled, and copy its signing secret.
5. **Cron.** `vercel.json` runs `/api/cron/send` every five minutes. Vercel's free plan allows only daily cron jobs, so use a paid plan for this schedule. Alternatively, call the same endpoint from an external scheduler every five minutes, with `Authorization: Bearer <CRON_SECRET>`.
6. **Deploy,** then sign in with a passkey on a phone to check the HTTPS origin. Passkeys won't work on `localhost` from a phone.

## Sending domain

The app sends from `invoices@<sending domain>`, with the user's own address as Reply-To. Publish these records at your DNS provider, using the exact values from Resend:

- **SPF:** a TXT record on the sending domain that includes Resend's sending host.
- **DKIM:** the TXT record Resend generates, under the selector it gives you.
- **DMARC:** a TXT record at `_dmarc.<domain>`. Start with `v=DMARC1; p=none;` to watch reports before tightening the policy.

The app cannot see DNS or inbox placement, so it never reports that a record is live or that mail reached an inbox. Check delivery in Resend.

## Stripe payments

Invoice Chaser connects each user's Stripe account with Stripe Connect (OAuth, Standard). It stores the connected account id, not an access token. Set these in `.env.local`; `.env.example` lists them. Never commit values.

- `STRIPE_CONNECT_CLIENT_ID`: the Connect client ID (`ca_…`). It builds the authorize link at `/api/stripe/connect`. Register `APP_URL/api/stripe/callback` as a redirect URI in the Stripe Connect settings.
- `STRIPE_SECRET_KEY`: the platform's secret key (`sk_…`). It runs the token exchange, deauthorizes a disconnected account, and makes payment calls for a connected account. It is not stored per user.
- `STRIPE_CONNECT_WEBHOOK_SECRET`: the signing secret of the platform webhook endpoint `APP_URL/api/webhooks/stripe`. Create that endpoint in Stripe to receive connected-account events, with `checkout.session.completed` enabled.
- `STRIPE_KEY_MODE`: leave unset in production. Set it to `restricted` only for internal testing. That allows connecting with a restricted key (`rk_…`) through per-connection webhook endpoints at `/api/webhooks/stripe/<token>`.

## Passkey sign-in

The account holder signs in with a passkey (Face ID, a fingerprint or a device PIN) and needs no code. The email link is the fallback for new devices, and it still works if every passkey is removed. The relying-party ID is the host of `APP_URL`, so a passkey only works on that host, over HTTPS. Sessions last 90 days and renew on each visit through `src/proxy.ts`. The server-side session also expires after 90 days without use.

Rate limits on sign-in challenges are held per server instance. That's acceptable for a single instance. Run more than one instance and the limit needs a shared table.

## Decisions and open items

**Decisions taken where the spec was silent or chose a default**

- Sign-in uses passkeys first, with the magic link as the fallback. Supabase Auth was not used.
- Stripe uses OAuth (Connect, Standard). No access token is stored.
- Reminders are transactional only. There is no marketing content and no unsubscribe link.
- Days to pay is measured from the due date. Negative means paid early. The issue-date average is a secondary figure.
- A payment on a disputed or written-off invoice marks it paid, and raises a Needs you item to confirm the dispute is resolved.
- New payment plans send reminders three days before, on, and seven days after each installment's due date. The seven-day reminder sends only while that installment is unpaid. Existing plans keep their schedule.
- Auto-send sends only the first message to a client. It never overrides a step's approval flag.
- The send window is 09:00 to 17:00 in the client's timezone, and users can narrow it but not widen it.
- The daily digest is sent only when there is something to report.
- Sending uses Resend, with the user's address as Reply-To.
- The daily cap defaults to 20 client messages per user per day.

**Open items and known limits**

- **Backups.** Use a managed Postgres service with daily backups and point-in-time recovery. Keep backups for 7 to 30 days, and state in the privacy policy that deleted data leaves backups within that window. Test a restore before launch.
- **Late-payment terms.** The generic text in the app needs review by a lawyer in each target jurisdiction before anyone relies on it.
- **Footer stop line.** A line asking clients to reply to stop is recommended but not yet added. Its wording needs approval.
- **Stripe live test.** Payment-link metadata reaching the checkout session, and Connect events reaching the platform endpoint, have not been tested in Stripe test mode.
- **Passkeys on a phone.** Sign-in is tested in automated browser checks, not on a physical device.
- **Send timing.** The sender runs every five minutes, so a due reminder can wait up to five minutes. A send already in progress when a stop arrives can complete, and the pause waits up to 30 seconds for it.
- **Dependencies.** The first install reported npm audit warnings, which have not been reviewed.
- **Visual review.** The final review found open issues on the invoice detail, the not-found page, the sequence editor on phone, and some tap targets under 44px.
- **Unknown record IDs.** A request for an invoice, client or sequence that does not exist shows the app's own not-found page, with a link back. The HTTP status is 200, because the signed-in layout streams its content. This is accepted for an authenticated app, and fixing it would mean moving the layout's streaming boundary.

## Learn more

- [Next.js documentation](https://nextjs.org/docs)
- [Stripe Connect](https://docs.stripe.com/connect)
- [Resend](https://resend.com/docs)
