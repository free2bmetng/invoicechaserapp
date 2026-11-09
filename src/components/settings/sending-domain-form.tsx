"use client";

// Sending domain and the DNS records for it. Each record name gets a copy button. A button copies only
// what the app knows: the domain the user saved, and the fixed parts of the record names. Values that
// come from the sending service get no button, because the app has no way to know them.
import { useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { TextInput } from "@/components/ui";
import { Callout, Field, fieldProps, SaveBar, useSettingsForm, type FormAction } from "./form-kit";
import { normalizeDomain } from "./rules";

const DMARC_VALUE = "v=DMARC1; p=none;";
const PLACEHOLDER_DOMAIN = "<your domain>";
// The reason a copy button is disabled. It sits beside the button, not in a note below the value.
const REASON_NO_DOMAIN = "Save a domain first";

// "none": no button, because the value is not known to the app. "{ value: null }": a button that is
// disabled until the app knows the value. "{ value: text }": a button that copies exactly that text.
type CopyRule = "none" | { value: string | null };

interface DnsLine {
  label: string;
  text: string;
  copy: CopyRule;
  note?: string;
}

// Text that may break only after a dot or an equals sign. The break points are zero-width <wbr>
// elements, so the copied text is unchanged and a value never splits mid-token.
function breakAfterDotsAndEquals(text: string) {
  const parts = text.split(/(?<=[.=])/);
  return parts.map((part, index) => (
    <span key={index}>
      {part}
      {index < parts.length - 1 ? <wbr /> : null}
    </span>
  ));
}

// Every record uses the same grid, so label, value and copy columns line up across DKIM, SPF and
// DMARC. The copy column has a fixed width whether or not the line has a button. On a phone the
// label and button share the first row and the value takes the full row below it.
function DnsRecord({ title, type, purpose, lines }: { title: string; type: string; purpose: string; lines: DnsLine[] }) {
  return (
    <article className="rounded-[var(--radius-md)] border border-line p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
        <span className="text-[12.5px] text-ink-3">Record type: {type}</span>
      </div>
      <p className="mt-1.5 text-[13.5px] leading-6 text-ink-2">{purpose}</p>
      <dl className="mt-4 grid gap-4">
        {lines.map((line) => (
          <div
            key={`${title}-${line.label}`}
            className="grid min-w-0 grid-cols-[minmax(0,1fr)_12rem] items-center gap-x-3 gap-y-2 sm:grid-cols-[4.5rem_minmax(0,1fr)_12rem]"
          >
            <dt className="col-start-1 row-start-1 text-[12.5px] font-medium text-ink-3">{line.label}</dt>
            <div className="col-start-2 row-start-1 flex items-center justify-end gap-3 sm:col-start-3">
              {line.copy === "none" ? null : (
                <>
                  {line.copy.value === null ? (
                    <span className="text-[12.5px] leading-5 text-ink-3">{REASON_NO_DOMAIN}</span>
                  ) : null}
                  <CopyButton
                    value={line.copy.value ?? ""}
                    disabled={line.copy.value === null}
                    label={`Copy the ${title} ${line.label.toLowerCase()}`}
                  />
                </>
              )}
            </div>
            {/* A record name stays on one line and scrolls sideways when the box is too narrow.
                Values wrap, but only after a dot, an equals sign or a space. */}
            <dd
              className={`col-span-2 col-start-1 row-start-2 min-w-0 overflow-x-auto rounded-[8px] bg-surface-2 px-3 py-2 font-mono text-[12.5px] leading-5 break-normal text-ink sm:col-span-1 sm:col-start-2 sm:row-start-1 ${
                line.label === "Name" ? "whitespace-nowrap" : "whitespace-normal"
              }`}
            >
              {line.label === "Name" ? line.text : breakAfterDotsAndEquals(line.text)}
            </dd>
            {line.note ? <p className="col-span-2 text-[12.5px] leading-5 text-ink-3 sm:col-span-3">{line.note}</p> : null}
          </div>
        ))}
      </dl>
    </article>
  );
}

export function SendingDomainForm({
  initialDomain,
  action,
  sendingEnabled,
  submitLabel = "Save sending domain",
}: {
  initialDomain: string | null;
  action: FormAction;
  sendingEnabled: boolean;
  submitLabel?: string;
}) {
  const form = useSettingsForm(action);
  const [domain, setDomain] = useState(initialDomain ?? "");
  const error = form.state.fieldErrors.sendingDomain;
  const normalized = normalizeDomain(domain);
  const known = normalized !== null;
  const shownDomain = normalized ?? PLACEHOLDER_DOMAIN;

  // DKIM names always end in ._domainkey.<domain>. The selector in front comes from the sending
  // service, so the button copies only the fixed end.
  const dkim: DnsLine[] = [
    {
      label: "Name",
      text: `<selector>._domainkey.${shownDomain}`,
      copy: { value: known ? `_domainkey.${normalized}` : null },
      note: known ? "The button copies the fixed end of the name. Put the selector from your sending service in front of it." : undefined,
    },
    {
      label: "Value",
      text: "<public key from your sending service>",
      copy: "none",
      note: "Copy from your sending service.",
    },
  ];
  const spf: DnsLine[] = [
    {
      label: "Name",
      text: shownDomain,
      copy: { value: normalized },
    },
    {
      label: "Value",
      text: "v=spf1 include:<from your sending service> ~all",
      copy: "none",
      note: "Replace the bracketed part with the value your sending service shows.",
    },
  ];
  const dmarc: DnsLine[] = [
    {
      label: "Name",
      text: `_dmarc.${shownDomain}`,
      copy: { value: known ? `_dmarc.${normalized}` : null },
    },
    { label: "Value", text: DMARC_VALUE, copy: { value: DMARC_VALUE } },
  ];

  return (
    <div className="flex flex-col gap-6">
      <form ref={form.formRef} onSubmit={form.onSubmit} noValidate className="flex flex-col gap-5">
        <Field
          id="sendingDomain"
          label="Sending domain"
          hint="The domain reminders come from, for example yourbusiness.com. Enter the domain only, without https:// or an @. Nothing is sent from a no-reply address."
          error={error}
        >
          <TextInput
            {...fieldProps("sendingDomain", { hasHint: true, error })}
            name="sendingDomain"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-required="true"
            className="max-w-xl"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
        </Field>

        <SaveBar pending={form.pending} state={form.state} idleLabel={submitLabel} pendingLabel="Saving…" />
      </form>

      {!sendingEnabled ? (
        <Callout tone="info">
          Real sending is switched off on this installation, so nothing leaves the app yet. Setting up the domain now
          means it is ready when sending is turned on.
        </Callout>
      ) : null}

      <div className="flex flex-col gap-5 border-t border-line pt-6">
        <div>
          <h3 className="text-[15px] font-semibold text-ink">Set up the DNS records</h3>
          <p className="mt-1.5 text-[14px] leading-6 text-ink-2">
            Add these records where your domain is managed, usually your domain registrar or DNS host.
          </p>
        </div>

        <ol className="flex list-decimal flex-col gap-3 pl-5 text-[14px] leading-6 text-ink marker:font-medium marker:text-ink-3">
          <li>Save your domain above. The names below then use it.</li>
          <li>
            Open your sending service and add the domain. It shows the exact DKIM and SPF values for it. Copy those
            values from there, because they are unique to your domain.
          </li>
          <li>Add the DKIM record at your DNS host, using the name and value from the sending service.</li>
          <li>
            Add the SPF record. A domain can have only one SPF record. If yours already has one, add the include to that
            record instead of creating a second one.
          </li>
          <li>Add the DMARC record. Its policy starts at p=none, which only watches your mail and does not change delivery.</li>
          <li>Back in the sending service, check that the domain shows as verified.</li>
        </ol>

        <DnsRecord
          title="DKIM"
          type="TXT or CNAME, as your sending service shows"
          purpose="Lets receiving mail servers confirm that a message really came from your domain."
          lines={dkim}
        />
        <DnsRecord title="SPF" type="TXT" purpose="Lists the services that may send mail for your domain." lines={spf} />
        <DnsRecord
          title="DMARC"
          type="TXT"
          purpose="Tells receiving servers what to do with mail that fails these checks, and it starts in watch-only mode."
          lines={dmarc}
        />
      </div>
    </div>
  );
}
