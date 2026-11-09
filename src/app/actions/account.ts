"use server";

// Deletes the signed-in account. The typed address is checked on the server against the stored
// address, so a client that skips the disabled button still cannot delete by mistake.
import { cookies } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { AccountDeletionRefusedError, deleteAccount } from "@/lib/account";
import { errorState, type FormState } from "@/components/settings/state";
import { requireUserId, SESSION_COOKIE } from "@/lib/session";

export async function deleteAccountAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const userId = await requireUserId();
  const typed = formData.get("confirmEmail");

  try {
    await deleteAccount(userId, typeof typed === "string" ? typed : "");
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof AccountDeletionRefusedError) {
      return errorState({ confirmEmail: err.message });
    }
    console.error(`[account] deletion failed: ${err instanceof Error ? err.name : "unknown error"}`);
    return errorState(
      {},
      "Deleting the account did not finish. Try again. If it keeps failing, contact the person who runs this installation.",
    );
  }

  // Only after the rows are gone: the cookie goes, then the browser goes to the login page.
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}
