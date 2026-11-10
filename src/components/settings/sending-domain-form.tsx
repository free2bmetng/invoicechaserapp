"use client";

// The sending domain: the domain field with Save beside it, then the DNS records for that domain.
// The records follow what is typed, so they are ready to copy before the save. A value the app
// cannot know (the sending service's DKIM key and SPF include) says where it comes from and gets
// no copy button. The app never looks up DNS, so every record honestly reads "Not checked".
import { useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/data";
import { Badge, Button, cx, TextInput } from "@/components/ui";
import { fieldProps, Panel, StatusLine, useSettingsForm, type FormAction } from "./form-kit";
import { normalizeDomain } from "./rules";

const DMARC_VALUE = "v=DMARC1; p=none;";
const FROM_SERVICE = "From your sending service";

interface DnsRecord {
  purpose: string;
  type: string;
  name: string | null;
  value: string | null;
}

export function dnsRecordsFor(domain: string): DnsRecord[] {
  return [
    { purpose: "DKIM", type: "TXT", name: null, value: null },
    { purpose: "SPF", type: "TXT", name: domain, value: null },
    { purpose: "DMARC", type: "TXT", name: `_dmarc.${domain}`, value: DMARC_VALUE },
  ];
}

// Long names may wrap, but only after a dot when possible. <wbr> adds no characters, so the
// selected text is unchanged (the copy button copies the plain string anyway).
function breakAfterDots(text: string) {
  const parts = text.split(/(?<=\.)/);
  return parts.map((part, index) => (
    <span key={index}>
      {part}
      {index < parts.length - 1 ? <wbr /> : null}
    </span>
  ));
}

function RecordCell({ text, what }: { text: string | null; what: string }) {
  if (text === null) return <span className="text-small text-ink-3">{FROM_SERVICE}</span>;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <code className="min-w-0 flex-1 rounded-[8px] border border-line bg-surface-2 px-2.5 py-1.5 font-mono text-[12.5px] leading-5 [overflow-wrap:anywhere] text-ink">
        {breakAfterDots(text)}
      </code>
      <CopyButton value={text} label={`Copy the ${what}`} />
    </span>
  );
}

export function DnsRecordsTable({ domain, sendingEnabled }: { domain: string | null; sendingEnabled: boolean }) {
  return (
    <Panel
      id="dns-records"
      title="DNS records"
      description={domain ? <>Add these where the DNS for {domain} is managed, usually your domain registrar.</> : undefined}
    >
      {domain ? (
        <div className="flex flex-col gap-3">
          <div className="-mx-4 border-y border-line sm:-mx-6">
            <Table label={`DNS records for ${domain}`}>
              <colgroup>
                <col className="w-[6.5rem]" />
                <col className="w-[40%]" />
                <col className="w-[40%]" />
                <col className="w-[8.5rem]" />
              </colgroup>
              <THead>
                <Th>Type</Th>
                <Th>Name</Th>
                <Th>Value</Th>
                <Th align="right">Status</Th>
              </THead>
              <TBody>
                {dnsRecordsFor(domain).map((record) => (
                  <Tr key={record.purpose}>
                    <Td primary>
                      <span className="font-medium text-ink">{record.type}</span>
                      <span className="ml-2 text-small text-ink-3 sm:ml-0 sm:block">{record.purpose}</span>
                    </Td>
                    <Td label="Name">
                      <RecordCell text={record.name} what={`${record.purpose} name`} />
                    </Td>
                    <Td label="Value">
                      <RecordCell text={record.value} what={`${record.purpose} value`} />
                    </Td>
                    <Td primary numeric>
                      <Badge>Not checked</Badge>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>
          <p className="text-small text-ink-3">
            DNS changes can take up to 48 hours. Invoice Chaser doesn&apos;t look them up, so each record shows Not checked.
            {sendingEnabled ? null : " Sending is switched off on this installation, so nothing is sent yet."}
          </p>
        </div>
      ) : (
        <p className="text-body text-ink-2">Enter your domain above to see the records to add.</p>
      )}
    </Panel>
  );
}

export function SendingDomainForm({
  initialDomain,
  action,
  sendingEnabled,
  submitLabel = "Save",
}: {
  initialDomain: string | null;
  action: FormAction;
  sendingEnabled: boolean;
  submitLabel?: string;
}) {
  const form = useSettingsForm(action);
  const [domain, setDomain] = useState(initialDomain ?? "");
  const error = form.state.fieldErrors.sendingDomain;
  const recordsDomain = normalizeDomain(domain) ?? normalizeDomain(initialDomain ?? "");
  const longLabel = submitLabel.length > 8;

  return (
    <div className="flex flex-col gap-6">
      <Panel id="domain" title="Your domain" description="Reminders are sent from this domain. Nothing is sent from a no-reply address.">
        <form ref={form.formRef} onSubmit={form.onSubmit} noValidate className="flex flex-col gap-1.5">
          <label htmlFor="sendingDomain" className="text-small font-medium text-ink">
            Domain
          </label>
          <div className={cx("flex max-w-lg gap-2", longLabel ? "flex-col sm:flex-row" : "flex-row")}>
            <TextInput
              {...fieldProps("sendingDomain", { hasHint: true, error })}
              name="sendingDomain"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-required="true"
              placeholder="yourbusiness.com"
              width="full"
              className={cx("min-w-0 font-mono text-[13.5px]", longLabel ? "sm:flex-1" : "flex-1")}
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
            />
            <Button type="submit" variant="primary" disabled={form.pending} aria-busy={form.pending || undefined} className="shrink-0 sm:h-11">
              {form.pending ? "Saving…" : submitLabel}
            </Button>
          </div>
          {error ? (
            <p id="sendingDomain-error" className="text-small font-medium text-danger">
              {error}
            </p>
          ) : (
            <p id="sendingDomain-hint" className="text-small text-ink-3">
              The domain only, such as yourbusiness.com, without https:// or an @.
            </p>
          )}
          {form.state.status === "error" && !error ? <StatusLine state={form.state} /> : null}
          {form.state.status === "saved" && form.state.message ? <StatusLine state={form.state} className="mt-1" /> : null}
        </form>
      </Panel>

      <DnsRecordsTable domain={recordsDomain} sendingEnabled={sendingEnabled} />
    </div>
  );
}
