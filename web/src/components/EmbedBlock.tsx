import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseEmbedUrl } from "@/lib/embed";

/**
 * `embed` block: player of a video hosted by YouTube / Vimeo, in a sandboxed
 * iframe. Only these two hosts can be framed (CSP `frame-src`), and the `src` is
 * rebuilt from a validated id (cf. `lib/embed`).
 *
 * Unlike an image or a video FILE, nothing is mirrored: the content belongs to
 * the platform. A reader therefore does load third-party content — which is why
 * this stays an explicit block and not an automatic behavior on any link.
 */
export function EmbedBlock({
  url,
  onChangeUrl,
}: {
  url: string;
  /** Absent = read-only render (public page): no URL form. */
  onChangeUrl?: (url: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(url);
  const target = parseEmbedUrl(url);

  if (target) {
    return (
      <div contentEditable={false} className="my-2 w-full">
        <div className="relative w-full overflow-hidden rounded-lg border bg-muted/30 pt-[56.25%]">
          <iframe
            src={target.src}
            title={t("editor.embed.frameTitle")}
            className="absolute inset-0 h-full w-full"
            loading="lazy"
            referrerPolicy="strict-origin-when-cross-origin"
            allow="fullscreen; picture-in-picture; encrypted-media"
            // The frame runs on the platform's origin: scripts and its own
            // storage are needed for the player, but it stays sandboxed from
            // ours (no top-level navigation, no form, no plugin).
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
            allowFullScreen
          />
        </div>
      </div>
    );
  }

  // Read-only and unusable URL: show the link rather than an empty box.
  if (!onChangeUrl) {
    return (
      <div contentEditable={false} className="my-2 w-full">
        {url ? (
          <a href={url} target="_blank" rel="noreferrer noopener" className="text-sm underline">
            {url}
          </a>
        ) : null}
      </div>
    );
  }

  return (
    <div
      contentEditable={false}
      className="my-2 w-full rounded-lg border border-dashed p-3"
      // Typing must not be captured by the editor's keyboard handling.
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onChangeUrl(draft.trim());
            }
          }}
          placeholder={t("editor.embed.placeholder")}
          aria-label={t("editor.embed.placeholder")}
        />
        <Button size="sm" onClick={() => onChangeUrl(draft.trim())}>
          {t("editor.embed.action")}
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {url ? t("editor.embed.invalid") : t("editor.embed.hint")}
      </p>
    </div>
  );
}
