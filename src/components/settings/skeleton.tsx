// Suspense fallback for the settings and onboarding bodies. Shows the rough shape of the cards so
// the page does not jump when the data arrives.
export function CardsSkeleton({ cards = 4 }: { cards?: number }) {
  return (
    <div className="mt-8 flex max-w-3xl flex-col gap-6" aria-busy="true" aria-label="Loading">
      {Array.from({ length: cards }, (_, index) => (
        <div key={index} className="flex flex-col gap-4 rounded-[var(--radius-lg)] border border-line bg-surface p-7">
          <div className="skeleton h-5 w-48" />
          <div className="skeleton h-4 w-full max-w-md" />
          <div className="skeleton h-10 w-full" />
        </div>
      ))}
    </div>
  );
}
