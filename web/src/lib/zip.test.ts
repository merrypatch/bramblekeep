import { describe, expect, it } from "vitest";

import { unzip, unzipAll, zipStore, type ZipEntry } from "./zip";
import { NOTION_ZIP_B64 } from "./__fixtures__/notionExport.b64";

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

describe("unzipAll (archives from elsewhere)", () => {
  it("inflates DEFLATE entries and keeps binary intact", async () => {
    const bytes = Uint8Array.from(atob(NOTION_ZIP_B64), (c) => c.charCodeAt(0));
    const files = await unzipAll(bytes);

    // Text came through the inflater, not truncated at the compressed size.
    const md = new TextDecoder().decode(files.get("Trip 1a2b3c4d5e6f.md")!);
    expect(md.startsWith("# Trip")).toBe(true);
    expect(md).toContain("plans and more plans");
    expect(md.length).toBeGreaterThan(1000); // it really was compressed

    // Binary is bytes, not a mangled UTF-8 round trip.
    const png = files.get("Trip 1a2b3c4d5e6f/photo.png")!;
    expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.length).toBe(8 + 256 * 4);

    // Directory entries are not files.
    expect([...files.keys()].some((k) => k.endsWith("/"))).toBe(false);
  });

  it("still refuses a method it cannot honestly read", async () => {
    // The STORE-only reader is what bundles use; it must keep saying no.
    const bytes = Uint8Array.from(atob(NOTION_ZIP_B64), (c) => c.charCodeAt(0));
    expect(() => unzip(bytes)).toThrow(/unsupported zip method 8/);
  });
});
