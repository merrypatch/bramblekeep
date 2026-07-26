import { Search } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  type ImageCredit,
  pickUnsplash,
  searchUnsplash,
  type StoredFile,
  type UnsplashPhoto,
  unsplashThumbUrl,
} from "@/lib/api";

/** Result of a pick: the mirrored file + the attribution to display. */
export type UnsplashPicked = StoredFile & { credit: ImageCredit | null };

/**
 * Unsplash photo picker. Search and thumbnails go through our server (the access
 * key stays there, the CSP stays closed), and choosing a photo mirrors it into
 * the FileStore — so the page never loads anything from Unsplash afterwards.
 *
 * Each result credits its photographer, as the Unsplash terms require, with the
 * links back that the server has already stamped with the UTM parameters.
 */
export function UnsplashPicker({ onPicked }: { onPicked: (picked: UnsplashPicked) => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [photos, setPhotos] = useState<UnsplashPhoto[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [pickingId, setPickingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setError(null);
    try {
      setPhotos(await searchUnsplash(q));
    } catch {
      setError(t("unsplash.searchFailed"));
      setPhotos(null);
    } finally {
      setSearching(false);
    }
  }

  async function pick(photo: UnsplashPhoto) {
    if (pickingId) return;
    setPickingId(photo.id);
    setError(null);
    try {
      onPicked(await pickUnsplash(photo.id));
    } catch {
      setError(t("unsplash.pickFailed"));
    } finally {
      setPickingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            autoFocus
            className="pl-7"
            placeholder={t("unsplash.placeholder")}
            aria-label={t("unsplash.placeholder")}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void run();
              }
            }}
          />
        </div>
        <Button size="sm" disabled={searching || !query.trim()} onClick={() => void run()}>
          {searching ? t("unsplash.searching") : t("unsplash.search")}
        </Button>
      </div>

      {photos && photos.length > 0 && (
        <div className="grid max-h-72 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
          {photos.map((p) => (
            <figure key={p.id} className="m-0 flex flex-col gap-1">
              <button
                type="button"
                title={p.alt || undefined}
                disabled={pickingId !== null}
                onClick={() => void pick(p)}
                className="relative aspect-[4/3] overflow-hidden rounded border hover:ring-2 hover:ring-primary disabled:opacity-50"
                style={{ backgroundColor: p.color }}
              >
                <img
                  src={unsplashThumbUrl(p.thumb_url)}
                  alt={p.alt}
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
                {pickingId === p.id && (
                  <span className="absolute inset-0 flex items-center justify-center bg-background/70 text-xs">
                    {t("unsplash.importing")}
                  </span>
                )}
              </button>
              {/* Attribution required by the Unsplash terms, on the result too. */}
              <figcaption className="truncate text-[11px] text-muted-foreground">
                <a
                  href={p.author_url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="hover:underline"
                >
                  {p.author}
                </a>
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      {photos?.length === 0 && !searching && (
        <p className="py-4 text-center text-xs text-muted-foreground">{t("unsplash.noResults")}</p>
      )}

      <p className="text-xs text-muted-foreground">
        {error ?? t("unsplash.hint")}{" "}
        <a
          href="https://unsplash.com/?utm_source=bramblekeep&utm_medium=referral"
          target="_blank"
          rel="noreferrer noopener"
          className="underline"
        >
          Unsplash
        </a>
      </p>
    </div>
  );
}
