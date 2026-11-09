// Keeps an active user signed in. On each page visit the browser's copy of the session cookie is
// re-issued with a fresh 90-day lifetime. The server-side session still expires on its own after
// 90 days without use (see src/lib/auth.ts), so this only refreshes the browser copy.
// It leaves alone sign-in, sign-out and API paths, which set or clear the cookie themselves.
// The lifetime is duplicated here, because the proxy must not import the database client.
import { NextResponse, type NextRequest } from "next/server";

const COOKIE = "ic_session";
const MAX_AGE_SECONDS = 90 * 24 * 60 * 60;
const SKIP_PREFIXES = ["/logout", "/auth/", "/api/"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const token = request.cookies.get(COOKIE)?.value;
  const response = NextResponse.next();
  if (!token || SKIP_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return response;

  response.cookies.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
