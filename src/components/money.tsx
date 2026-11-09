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

// Several per-currency amounts, one after another ("£1,200.00 · €300.00"). They are listed,
// never added together. Renders nothing for an empty list.
export function MoneyList({
  amounts,
  className,
}: {
  amounts: readonly { amountMinor: number; currency: string }[];
  className?: string;
}) {
  if (amounts.length === 0) return null;
  return (
    <span className={cx("num inline-flex flex-wrap items-baseline justify-end gap-x-1.5", className)}>
      {amounts.map((a, i) => (
        <span key={a.currency} className="whitespace-nowrap">
          {i > 0 ? (
            <span aria-hidden="true" className="mr-1.5 text-ink-3">
              ·
            </span>
          ) : null}
          <Money minor={a.amountMinor} currency={a.currency} />
        </span>
      ))}
    </span>
  );
}
