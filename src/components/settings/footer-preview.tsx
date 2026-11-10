// The footer every reminder ends with, drawn from the sender details. No hooks, so the server
// summary and the live onboarding preview render the same thing. Missing parts show as muted
// placeholders rather than an error, because the preview updates as the user types.
import { cx } from "@/components/ui";

export interface FooterValues {
  senderName: string;
  businessName: string;
  postalAddress: string;
}

function Missing({ children }: { children: string }) {
  return <span className="text-ink-3">{children}</span>;
}

export function FooterLines({ values, className }: { values: FooterValues; className?: string }) {
  const name = values.senderName.trim();
  const business = values.businessName.trim();
  const address = values.postalAddress
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    <div className={cx("font-mono text-[12.5px] leading-5 break-words text-ink", className)}>
      <p className="text-ink-3">---</p>
      <p>
        {name || <Missing>Your name</Missing>}, {business || <Missing>Business name</Missing>}
      </p>
      {address.length > 0 ? address.map((line, index) => <p key={index}>{line}</p>) : <p><Missing>Postal address</Missing></p>}
    </div>
  );
}

// A reminder framed like an email, with the live footer at the end. Used beside the onboarding form.
export function ReminderPreview({ values, domain }: { values: FooterValues; domain: string | null }) {
  const name = values.senderName.trim();
  return (
    <figure className="overflow-hidden rounded-[var(--radius-lg)] border border-line bg-surface shadow-card">
      <figcaption className="border-b border-line bg-surface-2 px-5 py-3 text-small font-medium text-ink-2">
        Preview of a reminder
      </figcaption>
      <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-y-1 border-b border-line px-5 py-3 text-small">
        <dt className="text-ink-3">From</dt>
        <dd className="truncate text-ink">
          {name || <Missing>Your name</Missing>}
          {domain ? <span className="text-ink-3"> · {domain}</span> : null}
        </dd>
        <dt className="text-ink-3">Subject</dt>
        <dd className="truncate text-ink">Invoice INV-1042 is now due</dd>
      </dl>
      <div className="flex flex-col gap-3 px-5 py-4 text-body text-ink-2">
        <p>Hi Sam,</p>
        <p>A friendly reminder that invoice INV-1042 for £1,250.00 was due on 3 March.</p>
        <p>
          Thanks,
          <br />
          {name || <Missing>Your name</Missing>}
        </p>
        <FooterLines values={values} className="mt-1 rounded-[var(--radius-md)] bg-surface-2 px-3 py-2.5" />
      </div>
    </figure>
  );
}
