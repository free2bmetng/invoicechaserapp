// Test environment. Real Postgres, fake providers, no network.
// TEST_DB_NAME lets parallel workers use separate databases so they never truncate each other.
const DB = process.env.TEST_DB_NAME ?? "invoice_chaser_test";
export const TEST_ENV = {
  DATABASE_ADMIN_URL: `postgres://postgres@localhost:5433/${DB}`,
  DATABASE_URL: `postgres://app_rls:app_rls_dev@localhost:5433/${DB}`,
  DATABASE_SERVICE_URL: `postgres://app_service:app_service_dev@localhost:5433/${DB}`,
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  CRON_SECRET: "test-cron-secret",
  PROVIDER_WEBHOOK_SECRET: "test-provider-webhook-secret",
  STRIPE_WEBHOOK_SECRET: "whsec_test_secret",
  APP_URL: "http://localhost:3000",
  SEND_ENABLED: "false",
};
