'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';

export interface HelpSearchItem {
  slug: string;
  title: string;
  summary: string;
  categoryLabel: string;
}

/**
 * Client-side search po KB. Przy ~24 artykułach nie ma sensu indeksować
 * server-side — prosty filtr substring po tytule + summary jest instant.
 */
export function HelpSearch({ items }: { items: HelpSearchItem[] }) {
  const [query, setQuery] = useState('');

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return items
      .filter(
        (it) =>
          it.title.toLowerCase().includes(q) ||
          it.summary.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [items, query]);

  return (
    <div className="relative text-left">
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-5 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Szukaj w pomocy"
          placeholder="Szukaj w pomocy, np. „korekta faktury”, „błąd KSeF”…"
          className="w-full rounded-full bg-card py-3.5 pr-5 pl-12 text-sm text-foreground shadow-sm ring-1 ring-border transition outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
        />
      </div>

      <div aria-live="polite">
        {query.trim().length >= 2 && (
          <div className="mt-3 overflow-hidden rounded-2xl bg-card shadow-lg shadow-primary/5 ring-1 ring-border">
            {results.length === 0 ? (
              <p className="px-5 py-4 text-sm text-muted-foreground">
                Brak wyników dla „{query}”. Spróbuj innych słów albo napisz do
                nas przez stronę kontaktu.
              </p>
            ) : (
              results.map((it) => (
                <Link
                  key={it.slug}
                  href={`/pomoc/${it.slug}`}
                  className="block border-b border-border px-5 py-3.5 transition-colors outline-none last:border-0 hover:bg-muted focus-visible:bg-muted"
                >
                  <p className="text-sm font-medium text-foreground">{it.title}</p>
                  <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                    {it.categoryLabel} · {it.summary}
                  </p>
                </Link>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
