// Loading skeletons shown by Suspense while the data behind a screen loads.
export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="grid gap-3" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton h-[88px] w-full" />
      ))}
    </div>
  );
}

export function FormSkeleton() {
  return (
    <div className="grid gap-5" aria-busy="true" aria-label="Loading">
      <div className="skeleton h-10 w-full" />
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="skeleton h-10 w-full" />
        <div className="skeleton h-10 w-full" />
      </div>
      <div className="skeleton h-10 w-full" />
      <div className="skeleton h-24 w-full" />
    </div>
  );
}

export function DetailSkeleton() {
  return (
    <div className="grid gap-6" aria-busy="true" aria-label="Loading">
      <div className="skeleton h-24 w-full" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="skeleton h-64 w-full" />
        <div className="skeleton h-64 w-full" />
      </div>
      <div className="skeleton h-48 w-full" />
    </div>
  );
}
