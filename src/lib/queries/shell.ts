// Data for the signed-in shell: the account email and the Needs you badge count.
import { withUser } from "@/lib/db";
import { listNeedsYou } from "@/lib/engine";

export async function getShellData(userId: string): Promise<{ email: string; needsYouCount: number }> {
  const [email, items] = await Promise.all([
    withUser(userId, async (c) => {
      const { rows } = await c.query<{ email: string }>("select email from users where id = $1", [userId]);
      return rows[0]?.email ?? "";
    }),
    listNeedsYou(userId),
  ]);
  return { email, needsYouCount: items.length };
}
