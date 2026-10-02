/** Rupees (number) -> paise (integer). */
export const toMinor = (amount: number): number => Math.round(amount * 100);
/** Paise (integer) -> rupees (number). */
export const fromMinor = (minor: number): number => minor / 100;
