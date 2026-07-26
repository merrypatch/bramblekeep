import { describe, expect, it } from "vitest";

import { EMBED_HOSTS, isEmbeddableUrl, parseEmbedUrl } from "./embed";

const ID = "dQw4w9WgXcQ";

describe("parseEmbedUrl — YouTube", () => {
  it("recognizes the usual forms", () => {
    for (const url of [
      `https://www.youtube.com/watch?v=${ID}`,
      `https://youtube.com/watch?v=${ID}&list=PL123`,
      `https://m.youtube.com/watch?v=${ID}`,
      `https://youtu.be/${ID}`,
      `https://www.youtube.com/embed/${ID}`,
      `https://www.youtube.com/shorts/${ID}`,
      `https://www.youtube.com/live/${ID}`,
      `youtube.com/watch?v=${ID}`, // pasted without a scheme
    ]) {
      expect(parseEmbedUrl(url), url).toEqual({
        provider: "youtube",
        id: ID,
        src: `${EMBED_HOSTS[0]}/embed/${ID}`,
      });
    }
  });

  it("keeps the start time", () => {
    expect(parseEmbedUrl(`https://youtu.be/${ID}?t=90`)?.src).toBe(
      `${EMBED_HOSTS[0]}/embed/${ID}?start=90`,
    );
    expect(parseEmbedUrl(`https://youtu.be/${ID}?t=90s`)?.src).toBe(
      `${EMBED_HOSTS[0]}/embed/${ID}?start=90`,
    );
    expect(parseEmbedUrl(`https://www.youtube.com/watch?v=${ID}&start=42`)?.src).toBe(
      `${EMBED_HOSTS[0]}/embed/${ID}?start=42`,
    );
    // Unusable value → no parameter, no injection.
    expect(parseEmbedUrl(`https://youtu.be/${ID}?t=abc`)?.src).toBe(
      `${EMBED_HOSTS[0]}/embed/${ID}`,
    );
  });

  it("refuses an id that is not one", () => {
    expect(parseEmbedUrl("https://www.youtube.com/watch?v=tooshort")).toBeNull();
    expect(parseEmbedUrl("https://www.youtube.com/watch?v=way_too_long_id_here")).toBeNull();
    expect(parseEmbedUrl("https://www.youtube.com/watch")).toBeNull();
    expect(parseEmbedUrl("https://www.youtube.com/feed/subscriptions")).toBeNull();
    // Injection attempt via the id: refused by the charset.
    expect(parseEmbedUrl("https://www.youtube.com/watch?v=../../evil")).toBeNull();
    expect(parseEmbedUrl(`https://www.youtube.com/watch?v=${ID}"><script>`)).toBeNull();
  });
});

describe("parseEmbedUrl — Vimeo", () => {
  it("recognizes the usual forms", () => {
    expect(parseEmbedUrl("https://vimeo.com/123456789")).toEqual({
      provider: "vimeo",
      id: "123456789",
      src: `${EMBED_HOSTS[1]}/video/123456789`,
    });
    expect(parseEmbedUrl("https://vimeo.com/channels/staffpicks/123456789")?.id).toBe("123456789");
    expect(parseEmbedUrl("https://player.vimeo.com/video/123456789")?.id).toBe("123456789");
  });

  it("keeps the hash of an unlisted video", () => {
    expect(parseEmbedUrl("https://vimeo.com/123456789/abc123def")?.src).toBe(
      `${EMBED_HOSTS[1]}/video/123456789?h=abc123def`,
    );
    expect(parseEmbedUrl("https://player.vimeo.com/video/123456789?h=abc123def")?.src).toBe(
      `${EMBED_HOSTS[1]}/video/123456789?h=abc123def`,
    );
    // Hash outside the expected charset → dropped, the video still embeds.
    expect(parseEmbedUrl("https://vimeo.com/123456789/ZZZ%20evil")?.src).toBe(
      `${EMBED_HOSTS[1]}/video/123456789`,
    );
  });

  it("refuses what is not a video", () => {
    expect(parseEmbedUrl("https://vimeo.com/upgrade")).toBeNull();
    expect(parseEmbedUrl("https://player.vimeo.com/")).toBeNull();
  });
});

describe("parseEmbedUrl — everything else", () => {
  it("refuses any other host, so frame-src stays meaningful", () => {
    for (const url of [
      "https://elsewhere.test/video.mp4",
      "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "",
      "   ",
      "nonsense",
    ]) {
      expect(parseEmbedUrl(url), url).toBeNull();
      expect(isEmbeddableUrl(url), url).toBe(false);
    }
  });

  it("only ever builds a src on the two allowlisted hosts", () => {
    for (const url of [
      `https://youtu.be/${ID}`,
      `https://www.youtube.com/shorts/${ID}`,
      "https://vimeo.com/123456789",
    ]) {
      const target = parseEmbedUrl(url);
      expect(target).not.toBeNull();
      expect(EMBED_HOSTS.some((h) => target?.src.startsWith(`${h}/`))).toBe(true);
    }
  });
});
