import { describe, expect, it } from "vitest";

import { isRemoteMediaUrl, localFileHash } from "./remoteMedia";

const ORIGIN = "https://notes.example.com";
const HASH = "sha256:0f".padEnd(71, "a");

describe("isRemoteMediaUrl", () => {
  it("spots a URL hosted elsewhere", () => {
    expect(isRemoteMediaUrl("https://elsewhere.test/photo.jpg", ORIGIN)).toBe(true);
    expect(isRemoteMediaUrl("http://elsewhere.test/photo.jpg", ORIGIN)).toBe(true);
    // Another port = another origin (a distinct server).
    expect(isRemoteMediaUrl("https://notes.example.com:8443/x.png", ORIGIN)).toBe(true);
  });

  it("leaves alone what is already local or carries no request", () => {
    expect(isRemoteMediaUrl(`${ORIGIN}/api/files/${HASH}`, ORIGIN)).toBe(false);
    expect(isRemoteMediaUrl(`/api/files/${HASH}`, ORIGIN)).toBe(false);
    expect(isRemoteMediaUrl("data:image/png;base64,AAAA", ORIGIN)).toBe(false);
    expect(isRemoteMediaUrl("blob:https://notes.example.com/1234", ORIGIN)).toBe(false);
    expect(isRemoteMediaUrl("", ORIGIN)).toBe(false);
    expect(isRemoteMediaUrl("not a url", ORIGIN)).toBe(false);
  });
});

describe("localFileHash", () => {
  it("extracts the hash of a file served by the app", () => {
    expect(localFileHash(`/api/files/${HASH}`)).toBe(HASH);
    expect(localFileHash(`https://notes.example.com/api/files/${HASH}`)).toBe(HASH);
  });

  it("returns null for anything else", () => {
    expect(localFileHash("https://elsewhere.test/photo.jpg")).toBeNull();
    expect(localFileHash("/api/files/")).toBeNull();
    expect(localFileHash("/api/files/not-a-hash")).toBeNull();
    expect(localFileHash("/api/files/sha256:zzzz")).toBeNull();
    expect(localFileHash("/other/path")).toBeNull();
    expect(localFileHash("")).toBeNull();
  });
});
