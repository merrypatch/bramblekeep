//! Minimal RFC 4180 CSV parser (reverse of the CSV export). Handles quoted
//! fields, escaped quotes (`""`), commas and newlines inside quotes, and both
//! `\n` and `\r\n` line endings. No dependency — kept to preserve the
//! single-binary / no-extra-dep property of the frontend.

/** Parses CSV text into a grid of string cells (one array per row). A trailing
 * newline does not produce an empty final row. Unterminated quotes are tolerated
 * (the field is flushed as-is). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; // strip a leading BOM
  const n = text.length;

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
    } else if (c === ",") {
      row.push(field);
      field = "";
      i++;
    } else if (c === "\r") {
      i++;
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else {
      field += c;
      i++;
    }
  }
  // Flush the last field/row unless the input ended exactly on a newline.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
