import { describe, expect, it, beforeEach } from "vitest";
import { resetDb, createUser } from "./helpers/db";
import { withUser, withService, closeDb } from "@/lib/db";

describe("tenant isolation infrastructure", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("withUser only sees the current user's rows; withService sees all", async () => {
    const a = await createUser("a@example.test");
    const b = await createUser("b@example.test");
    await withUser(a, async (c) => {
      const { rows } = await c.query("select id from users");
      expect(rows.map((r) => r.id)).toEqual([a]);
    });
    await withService(async (c) => {
      const { rows } = await c.query("select id from users order by email");
      expect(rows.map((r) => r.id)).toEqual([a, b]);
    });
    await closeDb();
  });
});
