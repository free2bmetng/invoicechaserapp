// Sign-in pages read search params, so they opt out of instant-navigation validation.
export const instant = false;

function Mark() {
  return (
    <span aria-hidden="true" className={`grid size-9 rounded-[10px] place-items-center bg-accent text-accent-ink shadow-[inset_0_1px_0_rgb(255_255_255/0.16)]`}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M5 4.5h14v15l-2.8-1.8-2.7 1.8L12 17.9l-1.5 1.5-2.7-1.8L5 19.5z" fill="currentColor" opacity=".35" />
        <path d="M8.5 9.5h7M8.5 13h4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function Wordmark() {
  return (
    <div className="flex items-center gap-2.5">
      <Mark />
      <span className="text-[16px] font-semibold tracking-[-0.01em] text-ink">Invoice Chaser</span>
    </div>
  );
}

// An illustration of what the product does: one invoice's reminders, from friendly to firm.
// Static example content, drawn with tokens only.
const EXAMPLE = [
  { when: "3 days before due", what: "A friendly heads-up", tone: "bg-neutral-fill", note: "Sent" },
  { when: "On the due date", what: "A polite reminder", tone: "bg-neutral-fill", note: "Sent" },
  { when: "7 days overdue", what: "A firmer follow-up", tone: "bg-warn-fill", note: "Waiting for you" },
  { when: "Paid", what: "Reminders stop on their own", tone: "bg-ok-fill", note: "" },
];

function BrandPanel() {
  return (
    <aside className="relative hidden flex-col justify-between overflow-hidden border-r border-line bg-surface-2 px-12 py-10 lg:flex">
      <Wordmark />
      <div className="max-w-[440px]">
        <p className="text-[30px] leading-[38px] font-semibold tracking-[-0.02em] text-ink">
          Get paid on time, without the awkward follow-up.
        </p>
        <p className="mt-3 text-body text-ink-2">
          Polite, well-timed reminders go out from your own domain, and stop the moment a client pays.
        </p>
        <div className="mt-8 rounded-[var(--radius-lg)] border border-line bg-surface p-5 shadow-card">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-small font-medium text-ink">Invoice INV-1042 · Northwind Studio</p>
            <p className="num text-small font-semibold text-ink">£1,250.00</p>
          </div>
          <ol className="mt-4 flex flex-col">
            {EXAMPLE.map((step, index) => (
              <li key={step.when} className="relative flex gap-3 pb-4 last:pb-0">
                {index < EXAMPLE.length - 1 ? (
                  <span aria-hidden="true" className="absolute top-3.5 bottom-0 left-[4.5px] w-px bg-line" />
                ) : null}
                <span aria-hidden="true" className={`relative mt-1.5 size-2.5 shrink-0 rounded-full ${step.tone}`} />
                <div className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-small font-medium text-ink">{step.what}</p>
                    <p className="text-small text-ink-3">{step.when}</p>
                  </div>
                  {step.note ? <p className="shrink-0 text-small text-ink-3">{step.note}</p> : null}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
      <p className="text-small text-ink-3">Your data stays yours. Export it or delete your account at any time.</p>
    </aside>
  );
}

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-surface lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <BrandPanel />
      <div className="flex min-h-dvh flex-col px-5 pt-8 pb-10 sm:px-8 lg:items-center lg:justify-center lg:py-12">
        <div className="lg:hidden">
          <Wordmark />
        </div>
        <main id="main" className="mt-10 w-full max-w-[380px] sm:mx-auto lg:mt-0">
          {children}
        </main>
      </div>
    </div>
  );
}
