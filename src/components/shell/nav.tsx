"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { MouseEvent, ReactNode } from "react";
import { cx } from "@/components/ui";

export type NavKey = "dashboard" | "needs" | "next7" | "invoices" | "clients" | "sequences" | "messages" | "settings";

export interface NavItem {
  key: NavKey;
  label: string;
  href: string;
  badge?: number;
}

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" } as const;

// Module-private on purpose: never export plain values from a "use client" module
// (a server component can't read them). Callers pass a key; NavList looks it up.
const ICONS: Record<NavKey, ReactNode> = {
  dashboard: <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="9" rx="1.5" {...stroke} /><rect x="13.5" y="3.5" width="7" height="5" rx="1.5" {...stroke} /><rect x="13.5" y="11.5" width="7" height="9" rx="1.5" {...stroke} /><rect x="3.5" y="15.5" width="7" height="5" rx="1.5" {...stroke} /></svg>,
  needs: <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l8.5 15H3.5z" {...stroke} /><path d="M12 10v3.5M12 16.5v.01" {...stroke} /></svg>,
  next7: <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2" {...stroke} /><path d="M3.5 10h17M8 3v4M16 3v4" {...stroke} /></svg>,
  invoices: <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h9l3.5 3.5v13.5H6z" {...stroke} /><path d="M9 12h6M9 15.5h4" {...stroke} /></svg>,
  clients: <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8.5" r="3.5" {...stroke} /><path d="M3 19.5c.8-3 3.2-4.5 6-4.5s5.2 1.5 6 4.5M16 5.2a3.5 3.5 0 010 6.6M18.5 14.6c1.4.8 2.2 2.4 2.5 4.9" {...stroke} /></svg>,
  sequences: <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h10M4 12h7M4 18h4" {...stroke} /><path d="M17 4v16M14.5 17.5L17 20l2.5-2.5" {...stroke} /></svg>,
  messages: <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16v10.5H9.5L5.5 19v-3H4z" {...stroke} /></svg>,
  settings: <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" {...stroke} /><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M5.6 18.4l1.6-1.6M16.8 7.2l1.6-1.6" {...stroke} /></svg>,
};

// Close the mobile <details> menu once a link is chosen (client navigation keeps it open otherwise).
function closeMenu(e: MouseEvent<HTMLElement>) {
  e.currentTarget.closest("details")?.removeAttribute("open");
}

export function NavList({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <ul className="flex flex-col gap-0.5" aria-label="Main">
      {items.map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <li key={item.key}>
            <Link
              href={item.href}
              aria-current={active ? "page" : undefined}
              onClick={closeMenu}
              className={cx(
                "group flex h-11 items-center gap-3 rounded-[10px] px-3 text-[14px] font-medium transition-colors duration-150",
                active ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
                "focus-visible:outline-offset-[-2px]",
              )}
            >
              <span className={cx("shrink-0", active ? "text-accent" : "text-ink-3 group-hover:text-ink-2")}>{ICONS[item.key]}</span>
              <span className="flex-1 truncate">{item.label}</span>
              {item.badge ? (
                <span
                  aria-label={`${item.badge} need${item.badge === 1 ? "s" : ""} your attention`}
                  className="num grid h-5 min-w-5 place-items-center rounded-full bg-warn px-1.5 text-[11px] font-semibold text-surface"
                >
                  {item.badge > 99 ? "99+" : item.badge}
                </span>
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
