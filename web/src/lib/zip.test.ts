import { describe, expect, it } from "vitest";

import { unzip, unzipAll, zipStore, type ZipEntry } from "./zip";
import { MARKDOWN_VAULT_B64 } from "./__fixtures__/markdownVault.b64";

async function roundtrip(entries: ZipEntry[]): Promise<ZipEntry[]> {
  const blob = zipStore(entries);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return unzip(bytes);
}

describe("zip — store roundtrip", () => {
  it("roundtrips multiple text entries", async () => {
    const entries: ZipEntry[] = [
      { name: "manifest.json", text: '{"version":1}' },
      { name: "db-1-people.csv", text: "Nom,Age\nAlice,30\nBob,40" },
      { name: "db-2-tasks.csv", text: '"a,b","c""d"' },
    ];
    const out = await roundtrip(entries);
    expect(out).toEqual(entries);
  });

  it("preserves unicode content and filenames", async () => {
    const entries: ZipEntry[] = [
      { name: "données-température.csv", text: "Nom,Température\ntemp,40.3 °C — élevé\n名前,値" },
    ];
    const out = await roundtrip(entries);
    expect(out).toEqual(entries);
  });

  it("handles an empty file entry", async () => {
    const entries: ZipEntry[] = [{ name: "empty.csv", text: "" }];
    const out = await roundtrip(entries);
    expect(out).toEqual(entries);
  });

  it("throws on a non-zip buffer", () => {
    expect(() => unzip(new Uint8Array([1, 2, 3, 4]))).toThrow();
  });
});

describe("unzipAll (archives written elsewhere)", () => {
  const bytes = () => Uint8Array.from(atob(MARKDOWN_VAULT_B64), (c) => c.charCodeAt(0));

  it("inflates DEFLATE entries", async () => {
    const files = await unzipAll(bytes());
    const md = new TextDecoder().decode(files.get("Projets.md")!);
    expect(md.startsWith("# Projets")).toBe(true);
    // Longer than its compressed form: it really went through the inflater and
    // was not simply copied at the stored size.
    expect(md.length).toBeGreaterThan(1000);
  });

  it("keeps binary entries as bytes", async () => {
    const png = (await unzipAll(bytes())).get("Projets/schema.png")!;
    expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.length).toBe(8 + 256 * 4); // not mangled by a UTF-8 round trip
  });

  it("does not report directory entries as files", async () => {
    const files = await unzipAll(bytes());
    expect([...files.keys()].some((k) => k.endsWith("/"))).toBe(false);
  });

  it("leaves the STORE-only reader refusing what it cannot honestly read", () => {
    expect(() => unzip(bytes())).toThrow(/unsupported zip method 8/);
  });
});
