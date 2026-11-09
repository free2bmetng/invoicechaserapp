import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { DashboardBody, NoInvoicesYet } from "@/components/ops/dashboard-view";
import { DashboardSkeleton } from "@/components/ops/skeletons";
import { PageHeader } from "@/components/ui";
import { systemClock } from "@/lib/clock";
import { loadDashboardState } from "@/lib/queries/dashboard";
import { requireUserId } from "@/lib/session";

export const metadata: Metadata = { title: "Dashboard" };

export default function DashboardPage() {
  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title="Dashboard"
        description="What is owed, what is overdue, and what needs you today."
      />
      <div className="mt-8">
        <Suspense fallback={<DashboardSkeleton />}>
          <DashboardContent />
        </Suspense>
      </div>
    </>
  );
}

async function DashboardContent() {
  const userId = await requireUserId();
  const state = await loadDashboardState(userId, systemClock);
  if (state.kind === "onboarding") redirect("/onboarding");
  if (state.kind === "empty") return <NoInvoicesYet />;
  return <DashboardBody data={state.data} />;
}
