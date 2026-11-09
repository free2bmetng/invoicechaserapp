// Downloads everything in the signed-in user's account as a zip of CSV files (spec 3.8).
// requireUserId() runs first, so an anonymous request is redirected to sign-in and reads nothing.
// The response is never cached, and the file name carries the local date of the download.
import { DateTime } from "luxon";
import { systemClock } from "@/lib/clock";
import { exportUserData } from "@/lib/export";
import { getUserTimezone } from "@/lib/queries/settings";
import { requireUserId } from "@/lib/session";

export async function GET(): Promise<Response> {
  const userId = await requireUserId();
  const [bytes, timezone] = await Promise.all([exportUserData(userId), getUserTimezone(userId)]);

  const now = systemClock.now();
  const day = DateTime.fromJSDate(now, { zone: timezone }).toISODate() ?? now.toISOString().slice(0, 10);

  // Copy into a fresh ArrayBuffer: a Uint8Array view is not a BodyInit under the current DOM typings.
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="invoice-chaser-export-${day}.zip"`,
      "Content-Length": String(body.byteLength),
      "Cache-Control": "no-store",
    },
  });
}
