import { formatDate } from "@/lib/locale";

//! Dynamic template variables, resolved at instantiation (duplication).
//! Syntax `{{token}}` (e.g. `{{date}}`, `{{n:3}}`). Pure, no I/O.

export type TokenCtx = {
  /** Date/time of the instantiation. */
  now: Date;
  /** Sequence number of the created row (auto-increment). */
  seq: number;
  /** Name of the user instantiating. */
  user: string;
};

const pad = (n: number, w: number) => String(n).padStart(w, "0");

/** Replaces the `{{...}}` tokens in a string. Unknown tokens are
 * left as-is. */
export function resolveTokens(str: string, ctx: TokenCtx): string {
  return str.replace(/\{\{\s*([a-zA-Z]+)(?::(\d+))?\s*\}\}/g, (whole, nameRaw: string, arg?: string) => {
    const name = nameRaw.toLowerCase();
    const d = ctx.now;
    switch (name) {
      case "date":
        return formatDate(d);
      case "datetime":
        return formatDate(d, { dateStyle: "short", timeStyle: "short" });
      case "time":
        return formatDate(d, { hour: "2-digit", minute: "2-digit" });
      case "year":
        return String(d.getFullYear());
      case "month":
        return pad(d.getMonth() + 1, 2);
      case "day":
        return pad(d.getDate(), 2);
      case "n":
      case "id":
        return arg ? pad(ctx.seq, Number(arg)) : String(ctx.seq);
      case "user":
        return ctx.user;
      default:
        return whole; // unknown token → unchanged
    }
  });
}

/** Local "YYYY-MM-DD" of a date (for date columns). */
export function isoDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
}

/** Date tokens that, in a template's Date column, mean "today". */
export const DATE_TOKEN_RE = /\{\{\s*(date|today|now|jour)\s*\}\}/i;

/** Catalog for input help (name, description, example). */
export const TEMPLATE_TOKENS: { token: string; key: string; example: string }[] = [
  { token: "{{date}}", key: "date", example: "10/07/2026" },
  { token: "{{datetime}}", key: "datetime", example: "10/07/2026 14:30" },
  { token: "{{time}}", key: "time", example: "14:30" },
  { token: "{{year}}", key: "year", example: "2026" },
  { token: "{{month}}", key: "month", example: "07" },
  { token: "{{day}}", key: "day", example: "10" },
  { token: "{{n}}", key: "n", example: "42" },
  { token: "{{n:3}}", key: "nPad", example: "042" },
  { token: "{{user}}", key: "user", example: "Robin" },
];
