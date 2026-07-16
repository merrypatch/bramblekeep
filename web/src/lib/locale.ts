import { enUS, es, fr, type Locale } from "date-fns/locale";

import i18n, { DEFAULT_LANGUAGE, isLanguage, type Language } from "@/i18n";

// Locale-aware formatting keyed off the active i18n language. Storage stays
// locale-neutral (ISO strings) — these helpers only affect display/edit.

const DATE_FNS: Record<Language, Locale> = { en: enUS, es, fr };
// First day of week per language: Sunday for English, Monday for es/fr.
const WEEK_START: Record<Language, 0 | 1> = { en: 0, es: 1, fr: 1 };

/** Active language, guaranteed to be one we support (falls back to default). */
export function currentLanguage(): Language {
  return isLanguage(i18n.language) ? i18n.language : DEFAULT_LANGUAGE;
}

/** BCP-47 tag passed to the `Intl` APIs. */
export function intlLocale(): string {
  return currentLanguage();
}

/** date-fns locale object for the active language. */
export function dateFnsLocale(): Locale {
  return DATE_FNS[currentLanguage()];
}

/** First day of the week (0 = Sunday, 1 = Monday) for the active language. */
export function weekStartsOn(): 0 | 1 {
  return WEEK_START[currentLanguage()];
}

/** Localized date/time via `Intl.DateTimeFormat`. */
export function formatDate(value: number | Date, opts?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(intlLocale(), opts).format(value);
}

/** Localized number via `Intl.NumberFormat`. */
export function formatNumber(value: number, opts?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(intlLocale(), opts).format(value);
}

/** Short weekday names, ordered by the active locale's first day of week. */
export function weekdayShortNames(): string[] {
  const ws = weekStartsOn();
  const fmt = new Intl.DateTimeFormat(intlLocale(), { weekday: "short" });
  // 2023-01-01 is a Sunday; offset by the week-start to rotate the array.
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2023, 0, 1 + ((ws + i) % 7))));
}

/** Long month names for the active locale (January…December). */
export function monthLongNames(): string[] {
  const fmt = new Intl.DateTimeFormat(intlLocale(), { month: "long" });
  return Array.from({ length: 12 }, (_, m) => fmt.format(new Date(2000, m, 1)));
}
