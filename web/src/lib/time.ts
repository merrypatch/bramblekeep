import { formatDate, intlLocale } from "@/lib/locale";

/** Human-readable delta from an epoch-ms timestamp ("now", "5 min ago", "2 days
 *  ago"), localized to the active language via `Intl.RelativeTimeFormat`. Beyond
 *  30 days it falls back to a localized short date. */
export function relative(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  const rtf = new Intl.RelativeTimeFormat(intlLocale(), { numeric: "auto" });
  if (s < 60) return rtf.format(0, "second"); // "now" / "maintenant" / "ahora"
  const m = Math.round(s / 60);
  if (m < 60) return rtf.format(-m, "minute");
  const h = Math.round(m / 60);
  if (h < 24) return rtf.format(-h, "hour");
  const d = Math.round(h / 24);
  if (d < 30) return rtf.format(-d, "day");
  return formatDate(ts);
}
