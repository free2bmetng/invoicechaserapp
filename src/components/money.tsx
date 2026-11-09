import { formatMoney, MoneyError } from "@/lib/money";
import { cx } from "@/components/ui";

// Renders integer minor units with the currency's own symbol and decimals.
// Tabular figures keep columns of amounts aligned. Never add amounts across
// currencies; callers group by currency and render one <Money> per group.
export function Money({
  minor,
  currency,
  className,
  locale,
}: {
  minor: number;
  currency: string;
  className?: string;
  locale?: string;
}) {
  let text: string;
  try {
    text = formatMoney(minor, currency, locale);
  } catch (err) {
    // An unknown code should be visible, never silently formatted as a guess.
    if (!(err instanceof MoneyError)) throw err;
    text = `${currency} ${minor} (minor units)`;
  }
  return <span className={cx("num whitespace-nowrap", className)}>{text}</span>;
}
