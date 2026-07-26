import { describe, expect, it } from "vitest";

import { isStale } from "./freshness";

describe("isStale", () => {
  it("accepts a bundle that matches the server", () => {
    expect(isStale("0.9.1", "0.9.1")).toBe(false);
    expect(isStale(" 0.9.1 ", "0.9.1")).toBe(false);
  });

  it("rejects an outdated bundle — the case that erases blocks from the CRDT", () => {
    expect(isStale("0.7.0", "0.9.1")).toBe(true);
  });

  it("rejects a bundle ahead of the server too", () => {
    // Bundle and binary ship from the same build, so this is just as impossible
    // as the reverse — and just as much a sign of a cache serving the wrong app.
    expect(isStale("0.10.0", "0.9.1")).toBe(true);
  });

  it("never locks the user out on an unknown version", () => {
    // No build stamp (unit tests, non-Vite build) or no answer from the server:
    // blocking would be worse than the risk it guards against.
    expect(isStale("", "0.9.1")).toBe(false);
    expect(isStale("0.9.1", "")).toBe(false);
    expect(isStale("   ", "0.9.1")).toBe(false);
    expect(isStale("", "")).toBe(false);
  });
});
