// A link styled like the Button primitive in ui.tsx, for navigation rather than submits.
import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "@/components/ui";

const base =
  "lift inline-flex h-10 items-center justify-center gap-2 rounded-[10px] px-4 text-sm font-medium select-none whitespace-nowrap " +
  "focus-visible:outline-offset-2";
const variants = {
  primary: "bg-accent text-accent-ink shadow-[0_1px_0_rgb(255_255_255/0.18)_inset,0_1px_2px_rgb(0_0_0/0.12)] hover:bg-accent-hover",
  secondary: "bg-surface text-ink border border-line-strong hover:border-ink-3 hover:bg-surface-2 shadow-card",
  ghost: "text-ink-2 hover:text-ink hover:bg-surface-2",
} as const;

export function LinkButton({
  href,
  children,
  variant = "secondary",
  className,
}: {
  href: string;
  children: ReactNode;
  variant?: keyof typeof variants;
  className?: string;
}) {
  return <Link href={href} className={cx(base, variants[variant], className)}>{children}</Link>;
}
