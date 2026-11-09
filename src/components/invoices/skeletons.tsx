// Loading skeletons shown by Suspense while the data behind a screen loads.
// Each one has the shape of the screen it stands in for, so nothing jumps when the data arrives.
export function ListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="grid gap-5" aria-busy="true" aria-label="Loading">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <div className="skeleton col-span-2 h-[112px] lg:col-span-1" />
        <div className="skeleton h-[112px]" />
        <div className="skeleton h-[112px]" />
      </div>
      <div className="skeleton h-10 w-full max-w-xl" />
      <div className="overflow-hidden rounded-[var(--radius-lg)] border border-line">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex h-14 items-center gap-4 border-b border-line px-5 last:border-b-0">
            <div className="skeleton h-3.5 w-20" />
            <div className="skeleton h-3.5 w-32" />
            <div className="skeleton ml-auto h-3.5 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function FormSkeleton() {
  return (
    <div className="grid gap-5" aria-busy="true" aria-label="Loading">
      <div className="skeleton h-11 w-full max-w-md" />
      <div className="skeleton h-11 w-full max-w-xs" />
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="skeleton h-11 w-full" />
        <div className="skeleton h-11 w-full" />
      </div>
      <div className="skeleton h-24 w-full" />
    </div>
  );
}

export function DetailSkeleton() {
  return (
    <div className="grid gap-6" aria-busy="true" aria-label="Loading">
      <div className="skeleton h-40 w-full" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="skeleton h-96 w-full" />
        <div className="grid content-start gap-6">
          <div className="skeleton h-56 w-full" />
          <div className="skeleton h-32 w-full" />
        </div>
      </div>
    </div>
  );
}
