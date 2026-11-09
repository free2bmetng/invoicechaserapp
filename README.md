This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Stripe payments

Invoice Chaser connects each user's Stripe account with Stripe Connect (OAuth, Standard). It stores the connected account id, not an access token. Set these in `.env.local`; `.env.example` lists them. Never commit values.

- `STRIPE_CONNECT_CLIENT_ID`: the Connect client ID (`ca_…`). It builds the authorize link at `/api/stripe/connect`. Register `APP_URL/api/stripe/callback` as a redirect URI in the Stripe Connect settings.
- `STRIPE_SECRET_KEY`: the platform's secret key (`sk_…`). It runs the token exchange, deauthorizes a disconnected account, and makes payment calls for a connected account. It is not stored per user.
- `STRIPE_CONNECT_WEBHOOK_SECRET`: the signing secret of the platform webhook endpoint `APP_URL/api/webhooks/stripe`. Create that endpoint in Stripe to receive connected-account events, with `checkout.session.completed` enabled.
- `STRIPE_KEY_MODE`: leave unset in production. Set it to `restricted` only for internal testing. That allows connecting with a restricted key (`rk_…`) through per-connection webhook endpoints at `/api/webhooks/stripe/<token>`.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
