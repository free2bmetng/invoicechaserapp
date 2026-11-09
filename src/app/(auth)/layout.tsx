// Sign-in pages read search params, so they opt out of instant-navigation validation.
export const instant = false;

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-[400px]">
        <div className="flex items-center gap-2.5">
          <span aria-hidden="true" className="grid h-9 w-9 place-items-center rounded-[10px] bg-accent text-accent-ink">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M5 4.5h14v15l-2.8-1.8-2.7 1.8L12 17.9l-1.5 1.5-2.7-1.8L5 19.5z" fill="currentColor" opacity=".35" />
              <path d="M8.5 9.5h7M8.5 13h4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </span>
          <span className="text-[15px] font-semibold tracking-[-0.01em] text-ink">Invoice Chaser</span>
        </div>
        <main id="main" className="mt-8 rounded-[var(--radius-xl)] border border-line bg-surface p-6 shadow-card sm:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
