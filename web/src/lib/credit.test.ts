import { describe, expect, it } from "vitest";

import { creditLine, parseCredit, providerLabel } from "./credit";

const RAW = JSON.stringify({
  provider: "unsplash",
  author: "Jane Doe",
  author_url: "https://unsplash.com/@jane?utm_source=bramblekeep&utm_medium=referral",
  source_url: "https://unsplash.com/photos/x?utm_source=bramblekeep&utm_medium=referral",
});

describe("parseCredit", () => {
  it("reads a stored credit", () => {
    expect(parseCredit(RAW)).toEqual({
      provider: "unsplash",
      author: "Jane Doe",
      author_url: "https://unsplash.com/@jane?utm_source=bramblekeep&utm_medium=referral",
      source_url: "https://unsplash.com/photos/x?utm_source=bramblekeep&utm_medium=referral",
    });
  });

  it("treats an unusable credit as absent", () => {
    expect(parseCredit(null)).toBeNull();
    expect(parseCredit("")).toBeNull();
    expect(parseCredit("not json")).toBeNull();
    expect(parseCredit("[]")).toBeNull();
    // No author → nothing to credit, better than "Photo by  on Unsplash".
    expect(parseCredit('{"provider":"unsplash"}')).toBeNull();
    expect(parseCredit('{"provider":"unsplash","author":"  "}')).toBeNull();
  });

  it("fills in missing links without failing", () => {
    expect(parseCredit('{"author":"Jane"}')).toEqual({
      provider: "",
      author: "Jane",
      author_url: "",
      source_url: "",
    });
  });
});

describe("creditLine", () => {
  const words = { by: "Photo by", on: "on" };

  it("words the credit the terms require", () => {
    const credit = parseCredit(RAW);
    expect(credit).not.toBeNull();
    if (credit) expect(creditLine(credit, words)).toBe("Photo by Jane Doe on Unsplash");
  });

  it("omits the provider when it is unknown", () => {
    const credit = parseCredit('{"author":"Jane"}');
    if (credit) expect(creditLine(credit, words)).toBe("Photo by Jane");
  });
});

describe("providerLabel", () => {
  it("capitalizes the known provider", () => {
    expect(providerLabel({ provider: "unsplash", author: "a", author_url: "", source_url: "" })).toBe(
      "Unsplash",
    );
    expect(providerLabel({ provider: "", author: "a", author_url: "", source_url: "" })).toBe("");
  });
});
