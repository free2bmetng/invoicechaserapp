// Server-side session helpers for pages, layouts and server actions.
// Only the raw session token lives in the cookie. The database stores its hash.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { io } from "next/cache";
import { currentUserId, SESSION_TTL_MS } from "@/lib/auth";
import { systemClock } from "@/lib/clock";

export const SESSION_COOKIE = "ic_session";

const isProduction = process.env.NODE_ENV === "production";

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: isProduction,
  path: "/",
  // The server-side session still expires on its own. This only limits how long the browser keeps the cookie.
  // It is set at sign-in and not re-issued on each use, because Server Components cannot write cookies.
  maxAge: Math.floor(SESSION_TTL_MS / 1000),
};

// Returns the signed-in user's id, or null. Reads the cookie through next/headers, so call it inside a request.
export async function getUserId(): Promise<string | null> {
  const jar = await cookies();
  // The session check compares expiry times with the current time. io() makes that read happen at
  // request time, so prerendering never sees new Date() (blocking-prerender-current-time). Under Cache
  // Components the docs prefer io() to connection(); it is a no-op outside a request, where connection() throws.
  await io();
  return currentUserId(jar.get(SESSION_COOKIE)?.value, systemClock);
}

// For protected pages and server actions: redirects to /login when there is no valid session.
export async function requireUserId(): Promise<string> {
  const userId = await getUserId();
  if (!userId) redirect("/login");
  return userId;
}
