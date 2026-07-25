import { describe, expect, it } from "vitest";

import { unzip, zipStore, type ZipEntry } from "./zip";

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
