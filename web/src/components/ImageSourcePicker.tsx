import { ArrowLeft, ImageIcon, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { UnsplashPicker } from "@/components/UnsplashPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { mirrorFileFromUrl, type StoredFile, uploadFile } from "@/lib/api";
import { useUnsplashAvailable } from "@/lib/unsplashStatus";

/**
 * "Where from?" panel for an image: computer or URL. Single entry point shared by
 * the page cover and the icon picker — one question, two answers, rather than one
 * button per source.
 *
 * A URL goes through the server-side mirror (`/api/v1/files/from-url`): the image
 * is imported once and served by us, so the CSP stays closed to third-party hosts
 * and the image survives its source disappearing.
 *
 * Only an image is accepted, and the check is on the MIME sniffed from the
 * CONTENT by the server — a file extension proves nothing.
 *
 * `allowUnsplash` adds a third source. It is opt-in per call site rather than
 * always on: an Unsplash photo must be credited where it is displayed, and some
 * slots (a 60px icon) have nowhere to put that credit.
 */
export function ImageSourcePicker({
  onPicked,
  autoFocusUrl = false,
  allowUnsplash = false,
}: {
  /** Called with the stored file once it is confirmed to be an image. */
  onPicked: (stored: StoredFile) => void | Promise<void>;
  /** Focus the URL field on mount (panel opened by an explicit click). */
  autoFocusUrl?: boolean;
  /** Offer Unsplash, if the installation has a key configured. */
  allowUnsplash?: boolean;
}) {
  const { t } = useTranslation();
  const fileInput = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unsplash, setUnsplash] = useState(false);
  const unsplashAvailable = useUnsplashAvailable();

  async function run(action: () => Promise<StoredFile>) {
    setBusy(true);
    setError(null);
    try {
      const stored = await action();
      if (!stored.mime?.startsWith("image/")) {
        setError(t("imageSource.notImage"));
        return;
      }
      await onPicked(stored);
    } catch {
      setError(t("imageSource.failed"));
    } finally {
      setBusy(false);
    }
  }

  // Unsplash mode takes over the panel: a search grid needs the room, and a
  // "back" link keeps the two other sources one click away.
  if (unsplash) {
    return (
      <div className="flex flex-col gap-2">
        <button
          type="button"
          className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setUnsplash(false)}
        >
          <ArrowLeft className="size-3.5" />
          {t("imageSource.back")}
        </button>
        <UnsplashPicker onPicked={(picked) => void onPicked(picked)} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Button variant="secondary" disabled={busy} onClick={() => fileInput.current?.click()}>
        <Upload className="mr-2 size-4" />
        {t("imageSource.upload")}
      </Button>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void run(() => uploadFile(file));
        }}
      />

      <div className="flex items-center gap-2">
        <span className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted-foreground">{t("imageSource.or")}</span>
        <span className="h-px flex-1 bg-border" />
      </div>

      <div className="flex gap-2">
        <Input
          value={url}
          autoFocus={autoFocusUrl}
          placeholder={t("imageSource.urlPlaceholder")}
          aria-label={t("imageSource.urlPlaceholder")}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && url.trim()) {
              e.preventDefault();
              void run(() => mirrorFileFromUrl(url.trim()));
            }
          }}
        />
        <Button
          disabled={busy || !url.trim()}
          onClick={() => void run(() => mirrorFileFromUrl(url.trim()))}
        >
          {busy ? t("imageSource.importing") : t("imageSource.use")}
        </Button>
      </div>

      {allowUnsplash && unsplashAvailable && (
        <Button variant="ghost" size="sm" onClick={() => setUnsplash(true)}>
          <ImageIcon className="mr-2 size-4" />
          {t("imageSource.unsplash")}
        </Button>
      )}

      <p className="text-xs text-muted-foreground">{error ?? t("imageSource.hint")}</p>
    </div>
  );
}
