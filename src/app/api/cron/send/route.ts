// Sender run plus the daily digest, triggered by Vercel Cron (every 5 minutes, see vercel.json).
// Vercel Cron sends GET, so both methods run the same job. Vercel attaches
// "Authorization: Bearer <CRON_SECRET>" when that env var is set.
import { createHash, timingSafeEqual } from "node:crypto";
import { systemClock } from "@/lib/clock";
import { runDigests, type DigestResult } from "@/lib/digest";
import { runSender } from "@/lib/engine";
import { emailFor, paymentsFor } from "@/lib/providers/factory";

export async function GET(request: Request): Promise<Response> {
  return runJob(request);
}

export async function POST(request: Request): Promise<Response> {
  return runJob(request);
}

async function runJob(request: Request): Promise<Response> {
  if (!isAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const appUrl = process.env.APP_URL;
  if (!appUrl) return Response.json({ error: "APP_URL is not set" }, { status: 500 });

  const sender = await runSender({ clock: systemClock, appUrl, emailFor, paymentsFor });

  // The digest runs after the sender and cannot stop it. A digest failure is reported in the
  // response, not thrown.
  let digest: DigestResult | { error: string };
  try {
    digest = await runDigests({ clock: systemClock, appUrl, emailFor });
  } catch (err) {
    digest = { error: err instanceof Error ? err.message : "unknown error" };
  }
  return Response.json({ sender, digest });
}

// Fails closed when the secret is unset. Comparing digests keeps the comparison constant-time
// whatever the presented length.
function isAuthorized(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header || !header.startsWith("Bearer ")) return false;
  const presented = header.slice("Bearer ".length);
  return timingSafeEqual(sha256(presented), sha256(secret));
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
