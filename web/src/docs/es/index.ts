/** Spanish documentation pages, bundled at build time (one chunk per language,
 * loaded only when the reader opens). Keys are file paths, values the raw
 * markdown. Adding a `.md` file next to this one is enough — the order and the
 * slug list live in `lib/docs.ts`. */
const pages = import.meta.glob("./*.md", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

export default pages;
