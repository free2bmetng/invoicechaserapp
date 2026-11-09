// Loading placeholders for each Suspense boundary. The visual blocks are hidden from
// assistive tech; the status line says what is loading.
export function QueueSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div role="status" className="flex flex-col gap-4">
      <span className="sr-only">Loading</span>
      <div aria-hidden="true" className="flex flex-col gap-4">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="rounded-[var(--radius-lg)] border border-line bg-surface p-6">
            <div className="skeleton h-5 w-44" />
            <div className="skeleton mt-3 h-4 w-3/4" />
            <div className="skeleton mt-2 h-4 w-1/2" />
            <div className="skeleton mt-5 h-10 w-48" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <div role="status" className="flex flex-col gap-6">
      <span className="sr-only">Loading your dashboard</span>
      <div aria-hidden="true" className="flex flex-col gap-6">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="skeleton h-56" />
          <div className="skeleton h-56" />
        </div>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div className="skeleton h-64" />
          <div className="skeleton h-64" />
        </div>
        <div className="skeleton h-72" />
      </div>
    </div>
  );
}

export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div role="status" className="rounded-[var(--radius-lg)] border border-line bg-surface">
      <span className="sr-only">Loading</span>
      <div aria-hidden="true" className="divide-y divide-line">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-4 px-5 py-4">
            <div className="skeleton h-4 w-28" />
            <div className="skeleton h-4 flex-1" />
            <div className="skeleton h-4 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function FormSkeleton() {
  return (
    <div role="status" className="rounded-[var(--radius-lg)] border border-line bg-surface p-6 shadow-card">
      <span className="sr-only">Loading</span>
      <div aria-hidden="true" className="flex flex-col gap-4">
        <div className="skeleton h-4 w-24" />
        <div className="skeleton h-10 w-full" />
        <div className="skeleton h-10 w-40" />
      </div>
    </div>
  );
}
