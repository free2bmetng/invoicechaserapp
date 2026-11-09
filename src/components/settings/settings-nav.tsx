// Section index for the settings page, plus the section wrapper. Server-rendered: plain anchors.
// On desktop the index is a sticky list beside the cards. On a phone it is a row of anchor chips
// that scrolls sideways, so every section is one tap away without a long scroll.
import type { ReactNode } from "react";
import { cx } from "@/components/ui";

export const SETTINGS_SECTIONS = [
  { id: "sender", label: "Sender" },
  { id: "sending", label: "Sending" },
  { id: "sign-in", label: "Sign-in" },
  { id: "payments", label: "Payments" },
  { id: "terms", label: "Terms" },
  { id: "account", label: "Account" },
] as const;

export function SettingsNav() {
  return (
    <nav
      aria-label="Settings sections"
      className="-mx-4 overflow-x-auto px-4 pb-1 lg:sticky lg:top-8 lg:mx-0 lg:self-start lg:overflow-visible lg:px-0 lg:pb-0"
    >
      <ul className="flex gap-2 lg:flex-col lg:gap-0.5">
        {SETTINGS_SECTIONS.map((section) => (
          <li key={section.id} className="shrink-0">
            <a
              href={`#${section.id}`}
              className={cx(
                "inline-flex h-9 items-center rounded-full border border-line bg-surface px-4 text-[13.5px] font-medium whitespace-nowrap text-ink-2",
                "transition-colors duration-150 hover:text-ink",
                "lg:h-10 lg:w-full lg:rounded-[10px] lg:border-0 lg:bg-transparent lg:px-3 lg:text-[14px] lg:hover:bg-surface-2",
              )}
            >
              {section.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// A group of related cards. Each card keeps its own Save button and server action.
export function SettingsSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-heading`} id={id} className="scroll-mt-28 lg:scroll-mt-8">
      <div className="border-t border-line pt-8">
        <h2 id={`${id}-heading`} className="text-[20px] leading-7 font-semibold tracking-[-0.015em] text-ink">
          {title}
        </h2>
        <p className="mt-1.5 max-w-2xl text-[14px] leading-6 text-ink-2">{description}</p>
      </div>
      <div className="mt-6 flex max-w-3xl flex-col gap-5">{children}</div>
    </section>
  );
}
