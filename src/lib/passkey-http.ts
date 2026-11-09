// HTTP helpers for the passkey route handlers. Every response is JSON and is never cached.
import { NextResponse } from "next/server";

export function jsonResponse(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function errorResponse(message: string, status: number): NextResponse {
  return jsonResponse({ error: message }, status);
}

// Reads a JSON object body. Anything else, including a missing or non-JSON content type, returns null.
// Requiring application/json also stops a cross-site HTML form from posting to these routes.
export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) return null;
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// The address the challenge rate limit counts against. The platform appends the address it saw to
// X-Forwarded-For, so the last entry is the one to trust. Earlier entries can be set by the client.
export function clientAddress(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const last = forwarded
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .pop();
    if (last) return last;
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

// Logs the error's class only. Messages and stack traces can hold request data.
export function logPasskeyFailure(scope: string, err: unknown): void {
  console.error(`Passkey ${scope} failed:`, err instanceof Error ? err.name : "unknown error");
}
