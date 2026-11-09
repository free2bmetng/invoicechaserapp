// Public surface of the scheduling engine. Everything else in this folder is internal.

// Setup and planning
export { provisionUser } from "./provision";
export { planInvoice, replanSequence, deleteStep } from "./plan";
export { planOpenInvoices } from "./invoices";
export { completeOnboarding, type OnboardingResult } from "./onboarding";
// The per-user advisory lock. Code outside the engine that writes user rows must take it first.
export { lockUser } from "./store";

// Clients and contacts (writes)
export {
  createClient,
  updateClient,
  upsertContact,
  removeContact,
  type ClientInput,
  type ClientPatch,
  type ContactInput,
  type ClientCreated,
} from "./clients";

// Invoices (writes)
export {
  createInvoice,
  updateInvoice,
  setInvoiceContacts,
  importInvoices,
  type InvoiceInput,
  type InvoicePatch,
  type InvoiceContacts,
  type ImportInvoiceRow,
  type ImportResult,
} from "./invoices";

// Sequences (writes)
export { saveSequence, listSequences, type SequenceInput, type SequenceStepInput, type SavedSequence, type SequenceView, type SequenceStepView, type Tone } from "./sequences";

// Status, payments and payment plans
export { setInvoiceStatus, recordPayment, setPaymentPlan, acknowledgePaidWhileDisputed, type RecordPaymentArgs, type PlanInstallmentInput } from "./stop";

// Provider feedback and holds
export {
  recordBounce,
  recordDeliveryStatus,
  recordReply,
  resumeContact,
  resumeClient,
  holdContact,
  type BounceArgs,
  type DeliveryStatusArgs,
} from "./holds";

// Message actions and auto-send
export {
  approveMessage,
  editMessage,
  holdMessage,
  resumeMessage,
  cancelMessage,
  retryFailed,
  resolveNeedsCheck,
} from "./approvals";
export { setAutoSend } from "./client";

// Sender
export { runSender, type SenderDeps, type RunSenderOptions, type RunSenderResult } from "./sender";

// Read helpers (withUser)
export {
  listInvoices,
  listClients,
  getInvoiceDetail,
  getClientDetail,
  type InvoiceListItem,
  type InvoiceListFilter,
  type ClientListItem,
  type ClientDetail,
  type ContactView,
  type InstallmentView,
  type MessageView,
  type EventView,
  type InvoiceDetail,
  type MoneyTotal,
} from "./reads";
export { listNeedsYou, listNextSevenDays, type NeedsYouItem, type NeedsYouKind, type UpcomingMessage } from "./queue";
export { type RenderNote } from "./render";

// Pure rules
export { defaultRequiresApproval, validateSequence, orderSteps, type StepRule } from "./sequence";
export { validateInstallments, type InstallmentInput } from "./installments";
export { isInsideWindow, nextWindowOpening, plannedAtFor } from "./window";
export { standardDedupeKey, planDedupeKey } from "./dedupe";

// Errors
export {
  EngineError,
  NotFoundError,
  InvalidStateError,
  ValidationError,
  InvalidTimezoneError,
  type EngineErrorCode,
} from "./errors";
