// One row per planned step. The key is stable across replanning, so a step can
// never produce a second row. installments have no invoice-level step, so the
// two forms are kept apart by the key's left-hand side.
export function standardDedupeKey(invoiceId: string, stepId: string): string {
  return `${invoiceId}:${stepId}`;
}

export function planDedupeKey(installmentId: string, stepId: string): string {
  return `${installmentId}:${stepId}`;
}
