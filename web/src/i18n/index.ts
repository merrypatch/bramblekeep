import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import { APP_NAME } from "@/lib/brand";

import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";

export const LANGUAGES = ["en", "es", "fr"] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = "en";

/** Endonyms shown in the language picker (same in every UI language). */
export const LANGUAGE_NAMES: Record<Language, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
};

/** Flag emoji per language, for a more visual picker. */
export const LANGUAGE_FLAGS: Record<Language, string> = {
  en: "🇬🇧",
  es: "🇪🇸",
  fr: "🇫🇷",
};

const STORAGE_KEY = "bk-lang";

export function isLanguage(v: unknown): v is Language {
  return typeof v === "string" && (LANGUAGES as readonly string[]).includes(v);
}

/** Boot language: localStorage cache, else English. The account's real language
 *  is applied after getMe() via setLanguage() — the cache only avoids a flash. */
export function initialLanguage(): Language {
  // Guarded for non-browser envs (unit tests import this transitively).
  const cached = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
  return isLanguage(cached) ? cached : DEFAULT_LANGUAGE;
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    es: { translation: es },
    fr: { translation: fr },
  },
  lng: initialLanguage(),
  fallbackLng: DEFAULT_LANGUAGE,
  // `{{app}}` resolves everywhere to the brand name, with no per-call argument.
  interpolation: { escapeValue: false, defaultVariables: { app: APP_NAME } },
  returnNull: false,
});

if (typeof document !== "undefined") document.documentElement.lang = i18n.language;

/** Switch active language: apply, persist the cache, update <html lang>. */
export function setLanguage(lang: Language): void {
  void i18n.changeLanguage(lang);
  if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, lang);
  if (typeof document !== "undefined") document.documentElement.lang = lang;
}

export default i18n;
