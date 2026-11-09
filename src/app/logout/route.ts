import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { endSession } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/session";

export async function POST(request: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await endSession(token);
  const response = NextResponse.redirect(new URL("/login", request.url), 303);
  response.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}
