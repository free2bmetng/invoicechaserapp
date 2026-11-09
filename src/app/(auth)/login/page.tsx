import type { Metadata } from "next";
import { Suspense } from "react";
import { FormSkeleton } from "@/components/ops/skeletons";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

type SearchParams = Promise<{ error?: string | string[] }>;

export default function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<FormSkeleton />}>
      <LoginContent searchParams={searchParams} />
    </Suspense>
  );
}

async function LoginContent({ searchParams }: { searchParams: SearchParams }) {
  const raw = await searchParams;
  const code = Array.isArray(raw.error) ? raw.error[0] : raw.error;
  return <LoginForm notice={noticeFor(code)} />;
}

function noticeFor(code: string | undefined): string | null {
  if (code === "expired") return "This sign-in link has expired or was already used. Request a new one below.";
  if (code === "unavailable") return "We could not sign you in just now. Request a new link and try again.";
  return null;
}
