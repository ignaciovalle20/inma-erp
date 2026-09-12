export const CURRENCIES = ["CLP", "UYU", "USD"] as const;

export type Currency = (typeof CURRENCIES)[number];
