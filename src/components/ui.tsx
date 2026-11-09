import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const buttonBase =
  "lift inline-flex items-center justify-center gap-2 rounded-[10px] font-medium select-none whitespace-nowrap " +
  "disabled:opacity-50 disabled:pointer-events-none active:translate-y-px";

const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-ink shadow-[0_1px_0_rgb(255_255_255/0.18)_inset,0_1px_2px_rgb(0_0_0/0.12)] hover:bg-accent-hover",
  secondary: "bg-surface text-ink border border-line-strong hover:border-ink-3 hover:bg-surface-2 shadow-card",
  ghost: "text-ink-2 hover:text-ink hover:bg-surface-2",
  danger: "bg-danger-soft text-danger border border-danger/30 hover:border-danger/60",
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md" }) {
  return (
    <button
      {...props}
      className={cx(
        buttonBase,
        size === "sm" ? "h-11 px-3 text-[13px]" : "h-11 px-4 text-sm",
        buttonVariants[variant],
        className,
      )}
    />
  );
}

export type Tone = "neutral" | "accent" | "warn" | "danger" | "ok" | "info";

const toneClasses: Record<Tone, string> = {
  neutral: "bg-surface-2 text-ink-2 border-line",
  accent: "bg-accent-soft text-accent border-accent/20",
  warn: "bg-warn-soft text-warn border-warn/25",
  danger: "bg-danger-soft text-danger border-danger/25",
  ok: "bg-ok-soft text-ok border-ok/20",
  info: "bg-info-soft text-info border-info/20",
};

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] font-medium leading-5 whitespace-nowrap",
        toneClasses[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Card({ children, className, as: Tag = "section" }: { children: ReactNode; className?: string; as?: "section" | "div" | "article" }) {
  return <Tag className={cx("rounded-[var(--radius-lg)] border border-line bg-surface shadow-card", className)}>{children}</Tag>;
}

export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-ink">
        {label}
      </label>
      {children}
      {hint && !error ? <p className="text-[12.5px] leading-5 text-ink-3">{hint}</p> : null}
      {error ? (
        <p role="alert" className="text-[12.5px] leading-5 text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const inputClass =
  "w-full h-11 rounded-[10px] border border-line-strong bg-surface px-3 text-[14px] text-ink placeholder:text-ink-3 " +
  "transition-[border-color,box-shadow] duration-150 hover:border-ink-3 focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent/20 " +
  "aria-[invalid=true]:border-danger aria-[invalid=true]:ring-danger/15";

export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(inputClass, className)} />;
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={cx(inputClass, "pr-8 appearance-none bg-no-repeat", className)}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'><path d='M1 1.5l5 5 5-5' fill='none' stroke='%236b6b74' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/></svg>\")",
        backgroundPosition: "right 12px center",
      }}
    >
      {children}
    </select>
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={cx(inputClass, "h-auto min-h-[120px] py-2.5 leading-6 resize-y", className)}
    />
  );
}

// Accessible on/off switch that also works in a plain HTML form (name + value).
export function Switch({
  name,
  defaultChecked,
  checked,
  onChange,
  label,
  description,
  id,
}: {
  name?: string;
  defaultChecked?: boolean;
  checked?: boolean;
  onChange?: (next: boolean) => void;
  label: string;
  description?: string;
  id: string;
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-3">
      <div className="min-w-0">
        <label htmlFor={id} className="text-[14px] font-medium text-ink">
          {label}
        </label>
        {description ? <p className="mt-0.5 text-[13px] leading-5 text-ink-3">{description}</p> : null}
      </div>
      <span className="relative inline-flex h-6 w-11 shrink-0">
        <input
          id={id}
          name={name}
          type="checkbox"
          role="switch"
          defaultChecked={defaultChecked}
          checked={checked}
          onChange={(e) => onChange?.(e.currentTarget.checked)}
          className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-full border border-line-strong bg-surface-2 transition-colors duration-200 peer-checked:border-accent peer-checked:bg-accent peer-focus-visible:ring-[3px] peer-focus-visible:ring-accent/25"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-[3px] left-[3px] h-[18px] w-[18px] rounded-full bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.25)] transition-transform duration-200 ease-out peer-checked:translate-x-5"
        />
      </span>
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 border-b border-line pb-6 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0">
        {eyebrow ? <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-3">{eyebrow}</p> : null}
        <h1 className="mt-1 text-[28px] leading-9 font-semibold tracking-[-0.02em] text-ink md:text-[32px] md:leading-10">{title}</h1>
        {description ? <p className="mt-2 max-w-2xl text-[15px] leading-6 text-ink-2">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function EmptyState({
  title,
  body,
  action,
  icon,
}: {
  title: string;
  body: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl border border-line bg-surface-2 text-accent">
        {icon ?? (
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5 4h14v16l-3-2-2 2-2-2-2 2-2-2-3 2V4z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="M9 9h6M9 13h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        )}
      </div>
      <h2 className="text-[16px] font-semibold text-ink">{title}</h2>
      <p className="max-w-sm text-[14px] leading-6 text-ink-2">{body}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
