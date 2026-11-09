// Auto-send switch. Turning it on releases rule (b) rows. Turning it off with no
// dispatch yet puts rule (b) rows back to pending approval.
import type { PoolClient } from "pg";
import type { Clock } from "@/lib/clock";
import { withUser } from "@/lib/db";
import * as S from "./store";
import { logEvent } from "./store";

// Inside the caller's transaction and lock.
export async function applyAutoSendTx(c: PoolClient, userId: string, clientId: string, autoSend: boolean, at: Date): Promise<void> {
  const client = await S.loadClient(c, userId, clientId);
  if (client.auto_send === autoSend) return;
  await c.query("update clients set auto_send = $3 where id = $1 and user_id = $2", [clientId, userId, autoSend]);
  await logEvent(c, { userId, clientId, type: "auto_send_changed", detail: { auto_send: autoSend }, at });
  if (autoSend) {
    await S.releaseRuleB(c, userId, clientId, at);
  } else if (!(await S.hasDispatched(c, userId, clientId))) {
    await S.revertRuleB(c, userId, clientId, at);
  }
}

export async function setAutoSend(userId: string, clientId: string, autoSend: boolean, clock: Clock): Promise<void> {
  await withUser(userId, async (c) => {
    await S.lockUser(c, userId);
    await applyAutoSendTx(c, userId, clientId, autoSend, clock.now());
  });
}
