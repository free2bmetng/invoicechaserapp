// Every ISO 4217 code the runtime knows, for currency pickers. Computed once per module load.
export const CURRENCIES: readonly string[] = Intl.supportedValuesOf("currency");
