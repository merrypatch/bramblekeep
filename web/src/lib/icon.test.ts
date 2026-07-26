import { describe, expect, it } from "vitest";

import { fileIconValue, iconFileHash, lucideValue, parseIcon } from "./icon";

const HASH = `sha256:${"ab".repeat(32)}`;

describe("parseIcon", () => {
  it("reads the three forms", () => {
    expect(parseIcon("lucide:rocket")).toEqual({ kind: "lucide", name: "rocket" });
    expect(parseIcon(fileIconValue(HASH))).toEqual({ kind: "file", hash: HASH });
    expect(parseIcon("🚀")).toEqual({ kind: "emoji", text: "🚀" });
  });

  it("treats absence as empty", () => {
    expect(parseIcon(null)).toEqual({ kind: "empty" });
    expect(parseIcon(undefined)).toEqual({ kind: "empty" });
    expect(parseIcon("")).toEqual({ kind: "empty" });
    expect(parseIcon("lucide:")).toEqual({ kind: "empty" });
  });

  it("degrades to text rather than pointing at a bogus file", () => {
    expect(parseIcon("file:")).toEqual({ kind: "emoji", text: "file:" });
    expect(parseIcon("file:not-a-hash")).toEqual({ kind: "emoji", text: "file:not-a-hash" });
    expect(parseIcon("file:sha256:zzz")).toEqual({ kind: "emoji", text: "file:sha256:zzz" });
    // Path traversal attempt in the hash: not hexadecimal → not a file.
    expect(parseIcon("file:sha256:../../etc/passwd")).toEqual({
      kind: "emoji",
      text: "file:sha256:../../etc/passwd",
    });
  });

  it("round-trips the encoders", () => {
    expect(parseIcon(lucideValue("star"))).toEqual({ kind: "lucide", name: "star" });
    expect(iconFileHash(fileIconValue(HASH))).toBe(HASH);
  });
});

describe("iconFileHash", () => {
  it("returns null for anything that is not an image icon", () => {
    expect(iconFileHash("🚀")).toBeNull();
    expect(iconFileHash("lucide:rocket")).toBeNull();
    expect(iconFileHash(null)).toBeNull();
    expect(iconFileHash("file:sha256:nothex")).toBeNull();
  });
});
