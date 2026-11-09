import Link from "next/link";
import { cookies } from "next/headers";
import { PasskeyOffer } from "@/components/passkey/passkey-offer";
import { PASSKEY_DISMISSED_COOKIE, PASSKEY_OFFER_COOKIE, passkeyOfferVisible } from "@/lib/passkey-offer";
import { requireUserId } from "@/lib/session";
import { getShellData } from "@/lib/queries/shell";
// Icons are looked up inside the client NavList by key. A server component can't read
// values exported from a "use client" module, which is why they used to render empty.
import { NavList, type NavItem } from "./nav";

// Server component. It reads the session and cookies, so it must sit inside a Suspense boundary.
export async function Shell({ children }: { children: React.ReactNode }) {
  const userId = await requireUserId();
  const { email, needsYouCount } = await getShellData(userId);
  const jar = await cookies();
  const showPasskeyOffer = passkeyOfferVisible(jar.get(PASSKEY_OFFER_COOKIE)?.value, jar.get(PASSKEY_DISMISSED_COOKIE)?.value);

  const items: NavItem[] = [
    { key: "dashboard", label: "Dashboard", href: "/" },
    { key: "needs", label: "Needs you", href: "/needs-you", badge: needsYouCount },
    { key: "next7", label: "Next 7 days", href: "/next-7-days" },
    { key: "invoices", label: "Invoices", href: "/invoices" },
    { key: "clients", label: "Clients", href: "/clients" },
    { key: "sequences", label: "Sequences", href: "/sequences" },
    { key: "messages", label: "Message log", href: "/messages" },
    { key: "settings", label: "Settings", href: "/settings" },
  ];

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[256px_minmax(0,1fr)]">
      <a
        href="#main"
        className="fixed top-3 left-3 z-50 -translate-y-[200%] rounded-[10px] bg-surface px-4 py-3 text-[14px] font-medium text-ink focus:translate-y-0 focus:shadow-pop"
      >
        Skip to content
      </a>
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-line bg-surface/80 px-4 py-6 backdrop-blur lg:flex">
        <Brand />
        <nav className="mt-8 flex-1 overflow-y-auto">
          <NavList items={items} />
        </nav>
        <AccountFooter email={email} />
      </aside>

      {/* Mobile header with a disclosure menu that works without JavaScript */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-surface/90 px-4 py-3 backdrop-blur lg:hidden">
        <Brand />
        <details className="group relative">
          <summary className="flex h-11 cursor-pointer list-none items-center gap-2 rounded-[10px] border border-line-strong bg-surface px-3 text-[14px] font-medium text-ink shadow-card transition-colors hover:bg-surface-2 group-open:bg-surface-2 marker:hidden [&::-webkit-details-marker]:hidden">
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" className="text-ink-2">
              <path d="M4 7h16M4 12h16M4 17h16" className="group-open:hidden" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <path d="M6 6l12 12M18 6 6 18" className="hidden group-open:block" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            Menu
            {needsYouCount ? (
              <span className="num grid h-5 min-w-5 place-items-center rounded-full bg-warn px-1.5 text-[11px] font-semibold text-surface">
                {needsYouCount > 99 ? "99+" : needsYouCount}
              </span>
            ) : null}
          </summary>
          <div className="absolute right-0 top-12 w-[min(320px,calc(100vw-2rem))] rounded-[var(--radius-lg)] border border-line bg-surface p-2 shadow-pop">
            <NavList items={items} />
            <div className="mt-2 border-t border-line pt-2">
              <AccountFooter email={email} compact />
            </div>
          </div>
        </details>
      </header>

      <main id="main" tabIndex={-1} className="mx-auto focus:outline-none w-full max-w-6xl px-4 pb-16 pt-8 sm:px-6 lg:px-10 lg:pt-10">
        {showPasskeyOffer ? <PasskeyOffer /> : null}
        {children}
      </main>
    </div>
  );
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5 rounded-lg px-1 py-1 text-ink no-underline">
      <span aria-hidden="true" className="grid h-8 w-8 place-items-center rounded-[10px] bg-accent text-accent-ink">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path d="M5 4.5h14v15l-2.8-1.8-2.7 1.8L12 17.9l-1.5 1.5-2.7-1.8L5 19.5z" fill="currentColor" opacity=".35" />
          <path d="M8.5 9.5h7M8.5 13h4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </span>
      <span className="text-[15px] font-semibold tracking-[-0.01em]">Invoice Chaser</span>
    </Link>
  );
}

function AccountFooter({ email, compact = false }: { email: string; compact?: boolean }) {
  return (
    <div className={compact ? "flex items-center justify-between gap-3 px-1 py-1" : "flex items-center justify-between gap-3 rounded-[12px] border border-line bg-surface-2 px-3 py-2.5"}>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">Signed in</p>
        <p className="truncate text-[13px] text-ink-2" title={email}>{email || "Account"}</p>
      </div>
      <form action="/logout" method="post">
        <button type="submit" className="h-11 whitespace-nowrap rounded-[8px] px-3 text-[13px] font-medium text-ink-2 transition-colors hover:bg-surface hover:text-ink">
          Sign out
        </button>
      </form>
    </div>
  );
}
