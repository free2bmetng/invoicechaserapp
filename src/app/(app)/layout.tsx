import { Suspense } from "react";
import { Shell } from "@/components/shell/shell";

// Every page here reads the session and the user's data, so it can't be prerendered.
// The shell streams in behind this boundary.
export const instant = false;

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<ShellFallback />}>
      <Shell>{children}</Shell>
    </Suspense>
  );
}

function ShellFallback() {
  return (
    <div className="min-h-dvh" aria-busy="true" aria-label="Loading">
      <div className="mx-auto max-w-6xl space-y-4 px-4 py-10 sm:px-6 lg:px-10">
        <div className="skeleton h-9 w-64" />
        <div className="skeleton h-4 w-96 max-w-full" />
        <div className="grid gap-4 pt-6 md:grid-cols-3">
          <div className="skeleton h-28" />
          <div className="skeleton h-28" />
          <div className="skeleton h-28" />
        </div>
      </div>
    </div>
  );
}
