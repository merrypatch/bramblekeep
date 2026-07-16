import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Input } from "@/components/ui/input";
import { search, type SearchHit } from "@/lib/api";

/** Renders a snippet: segments in brackets (FTS markers) are highlighted. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]*\])/g);
  return (
    <span className="line-clamp-2 text-xs text-muted-foreground">
      {parts.map((p, i) =>
        p.startsWith("[") && p.endsWith("]") ? (
          <mark key={i} className="bg-transparent font-medium text-foreground">
            {p.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </span>
  );
}

/** Full-text search bar (debounced); a click opens the page. */
export function SearchBox({ onSelect }: { onSelect: (id: string) => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);

  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setHits([]);
      return;
    }
    const t = setTimeout(() => {
      void search(term)
        .then(setHits)
        .catch(() => setHits([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div className="px-2 py-1">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("search.placeholder")}
          className="h-8 pl-7 text-sm"
        />
      </div>
      {q.trim() && (
        <ul className="mt-1 space-y-0.5">
          {hits.length === 0 ? (
            <li className="px-2 py-1 text-xs text-muted-foreground">{t("search.noResults")}</li>
          ) : (
            hits.map((h) => (
              <li key={h.item_id}>
                <button
                  onClick={() => {
                    onSelect(h.item_id);
                    setQ("");
                  }}
                  className="w-full rounded px-2 py-1 text-left hover:bg-accent"
                >
                  <div className="truncate text-sm">{h.title || t("common.untitled")}</div>
                  <Snippet text={h.snippet} />
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
