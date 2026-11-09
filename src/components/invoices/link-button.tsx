// A link styled like the Button primitive in ui.tsx, for navigation rather than submits.
import Link from "next/link";
import type { ReactNode } from "react";
import { buttonClass, cx } from "@/components/ui";

export function LinkButton({
  href,
  children,
  variant = "secondary",
  size = "md",
  className,
}: {
  href: string;
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
  className?: string;
}) {
  return <Link href={href} className={cx(buttonClass(variant, size), className)}>{children}</Link>;
}
