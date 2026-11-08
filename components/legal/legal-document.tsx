import Link from 'next/link';
import type { ReactNode } from 'react';
import { FilePenLine } from 'lucide-react';

import {
  entryChildren,
  entryText,
  listLabel,
  parseInline,
  type Block,
  type LegalDocument,
  type ListEntry,
} from '@/lib/legal/doc-model';
import { isLegalEntityComplete, missingLegalEntityFields } from '@/lib/legal/entity';

/**
 * Renderer dokumentów prawnych (`lib/legal/documents/*`). Server Component —
 * treść jest statyczna, a ta sama treść idzie mailem jako plik tekstowy.
 *
 * Plik importują też formularze klienckie (`LegalInline`), więc nie ładuje
 * listy dokumentów ani nagłówka strony. Stronę dokumentu (nagłówek,
 * nawigacja, treść) składa `components/legal/legal-page.tsx`.
 */

function Inline({
  text,
  linkClassName,
  newTab = false,
}: {
  text: string;
  linkClassName?: string;
  newTab?: boolean;
}) {
  return (
    <>
      {parseInline(text).map((t, i) => {
        if (t.kind === 'bold') return <strong key={i}>{t.value}</strong>;
        if (t.kind === 'link') {
          if (!newTab && (t.href.startsWith('/') || t.href.startsWith('#'))) {
            return (
              <Link key={i} href={t.href} className={linkClassName}>
                {t.value}
              </Link>
            );
          }
          return (
            <a key={i} href={t.href} target="_blank" rel="noopener noreferrer" className={linkClassName}>
              {t.value}
            </a>
          );
        }
        return <span key={i}>{t.value}</span>;
      })}
    </>
  );
}

/**
 * Oświadczenie z linkami (np. pole akceptacji regulaminu) — to samo brzmienie,
 * które zapisujemy. Linki w nowej karcie: przejście w tej samej karcie
 * skasowałoby wypełniony formularz.
 */
export function LegalInline({ text, linkClassName }: { text: string; linkClassName?: string }) {
  return <Inline text={text} linkClassName={linkClassName} newTab />;
}

function List({ items, ordered, depth }: { items: ListEntry[]; ordered: boolean; depth: number }) {
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag className="my-3 list-none space-y-2 pl-0">
      {items.map((entry, i) => {
        const children = entryChildren(entry);
        return (
          <li key={i} className="my-0 flex gap-2 pl-0">
            <span className="w-7 shrink-0 text-right tabular-nums text-muted-foreground">
              {ordered ? listLabel(depth, i) : '•'}
            </span>
            <div className="min-w-0 flex-1">
              <Inline text={entryText(entry)} />
              {children.length > 0 ? <List items={children} ordered={ordered} depth={depth + 1} /> : null}
            </div>
          </li>
        );
      })}
    </Tag>
  );
}

function BlockView({ block }: { block: Block }): ReactNode {
  switch (block.type) {
    case 'p':
      return (
        <p>
          <Inline text={block.text} />
        </p>
      );
    case 'note':
      return (
        <div className="not-prose my-6 rounded-2xl bg-accent px-5 py-4 text-[0.95rem] leading-relaxed text-accent-foreground">
          <Inline text={block.text} linkClassName="font-medium underline underline-offset-2" />
        </div>
      );
    case 'ol':
      return <List items={block.items} ordered depth={0} />;
    case 'ul':
      return <List items={block.items} ordered={false} depth={0} />;
    case 'table':
      return (
        <div className="my-6 overflow-x-auto">
          <table className="my-0 min-w-[640px] text-sm">
            <thead>
              <tr>
                {block.head.map((h, i) => (
                  <th key={i} className="align-bottom">
                    <Inline text={h} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className="align-top">
                      <Inline text={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/** Baner, dopóki dane usługodawcy są niepełne — nikt nie weźmie projektu za umowę. */
export function LegalDraftBanner() {
  if (isLegalEntityComplete()) return null;
  return (
    <div
      role="note"
      className="not-prose mb-10 flex gap-4 rounded-2xl bg-card p-5 text-sm leading-relaxed ring-1 ring-border"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">
        <FilePenLine aria-hidden className="size-4" />
      </span>
      <div>
        <p className="font-semibold text-foreground">Wersja robocza dokumentu</p>
        <p className="mt-1 text-muted-foreground">
          Dokument czeka na uzupełnienie danych usługodawcy i weryfikację prawną. Brakuje:{' '}
          {missingLegalEntityFields().join(', ')}.
        </p>
      </div>
    </div>
  );
}

/**
 * Treść dokumentu: streszczenie, wstawka strony (np. ustawienia cookies),
 * spis treści i paragrafy. Tytuł i wersję pokazuje nagłówek strony
 * (`LegalDocumentView` w `legal-page.tsx`).
 */
export function LegalDocumentBody({
  doc,
  children,
}: {
  doc: LegalDocument;
  /** Dodatkowa treść między streszczeniem a dokumentem (np. ustawienia cookies). */
  children?: ReactNode;
}) {
  return (
    <>
      {doc.summary && doc.summary.length > 0 ? (
        <section
          aria-labelledby="w-skrocie"
          className="not-prose my-10 rounded-2xl bg-muted/50 p-6 ring-1 ring-border sm:p-8"
        >
          <h2 id="w-skrocie" className="text-lg font-semibold tracking-tight">
            W skrócie
          </h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-[0.95rem] leading-relaxed marker:text-primary">
            {doc.summary.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-muted-foreground">
            Streszczenie ułatwia lekturę, ale wiąże wyłącznie pełna treść poniżej.
          </p>
        </section>
      ) : null}

      {children}

      <nav aria-label="Spis treści" className="not-prose my-10 rounded-2xl p-6 ring-1 ring-border sm:p-8">
        <p className="text-sm font-semibold">Spis treści</p>
        <ol className="mt-3 columns-1 gap-8 space-y-1.5 text-sm sm:columns-2">
          {doc.sections.map((s) => (
            <li key={s.id} className="break-inside-avoid">
              <a
                href={`#${s.id}`}
                className="text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
              >
                {s.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      {doc.sections.map((s) => (
        <section key={s.id} id={s.id} className="scroll-mt-8">
          <h2>{s.title}</h2>
          {s.blocks.map((b, i) => (
            <BlockView key={i} block={b} />
          ))}
        </section>
      ))}
    </>
  );
}
