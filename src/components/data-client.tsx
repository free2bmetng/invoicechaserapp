"use client";

// Client half of the data primitives. Only components and hooks are exported
// from here: a server component can render a client component, but it cannot
// read plain values (objects, arrays, constants) exported from a client module.

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "./ui";

type EditableSectionApi = { editing: boolean; open: () => void; close: () => void };

const EditableSectionContext = createContext<EditableSectionApi | null>(null);

// For client forms inside an EditableSection, e.g. close after a successful save:
//   const section = useEditableSection(); useEffect(() => { if (state.ok) section?.close(); }, [state]);
export function useEditableSection(): EditableSectionApi | null {
  return useContext(EditableSectionContext);
}

const FOCUSABLE =
  'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

// Read-only summary with an Edit button. Edit swaps the form (children) in, in
// place. Any element inside the form marked `data-edit-cancel` (for example
// <Button type="button" data-edit-cancel>Cancel</Button>, which works from a
// server component) returns to the summary, as does Escape. Focus moves to the
// first field on open and back to Edit on close.
export function EditableSection({
  title,
  description,
  summary,
  editLabel = "Edit",
  children,
}: {
  title: string;
  description?: string;
  summary: ReactNode;
  editLabel?: string;
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const headingId = useId();
  const regionId = useId();
  const editButton = useRef<HTMLButtonElement>(null);
  const formRegion = useRef<HTMLDivElement>(null);
  const wasEditing = useRef(false);

  const open = useCallback(() => setEditing(true), []);
  const close = useCallback(() => setEditing(false), []);

  useEffect(() => {
    if (editing) {
      const first = formRegion.current?.querySelector<HTMLElement>(FOCUSABLE);
      first?.focus();
    } else if (wasEditing.current) {
      editButton.current?.focus();
    }
    wasEditing.current = editing;
  }, [editing]);

  return (
    <EditableSectionContext.Provider value={{ editing, open, close }}>
      <section
        aria-labelledby={headingId}
        className="rounded-[var(--radius-lg)] border border-line bg-surface shadow-card"
      >
        <div className="flex items-start justify-between gap-4 px-4 pt-4 sm:px-6 sm:pt-5">
          <div className="min-w-0">
            <h2 id={headingId} className="text-card-title text-ink">
              {title}
            </h2>
            {description ? <p className="mt-0.5 text-small text-ink-3">{description}</p> : null}
          </div>
          {editing ? null : (
            <Button
              ref={editButton}
              type="button"
              size="sm"
              onClick={open}
              aria-expanded={false}
              aria-controls={regionId}
              className="-my-1.5 shrink-0"
            >
              {editLabel}
              <span className="sr-only"> {title}</span>
            </Button>
          )}
        </div>
        <div id={regionId} className="px-4 pt-3 pb-4 sm:px-6 sm:pb-5">
          {editing ? (
            <div
              ref={formRegion}
              onClick={(e) => {
                if ((e.target as Element).closest("[data-edit-cancel]")) close();
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape" && !e.defaultPrevented) {
                  e.stopPropagation();
                  close();
                }
              }}
            >
              {children}
            </div>
          ) : (
            summary
          )}
        </div>
      </section>
    </EditableSectionContext.Provider>
  );
}

// Optional ready-made Cancel button for forms rendered inside an EditableSection.
export function EditCancelButton({ children = "Cancel" }: { children?: ReactNode }) {
  return (
    <Button type="button" variant="ghost" data-edit-cancel="">
      {children}
    </Button>
  );
}
