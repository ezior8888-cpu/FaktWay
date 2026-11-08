/**
 * Model dokumentu prawnego: jedna treść, dwa wyjścia.
 *
 * Regulamin i umowa powierzenia muszą trafić do klienta na TRWAŁYM NOŚNIKU
 * (art. 21 ust. 1 ustawy o prawach konsumenta — dotyczy też przedsiębiorcy na
 * prawach konsumenta, art. 7aa). Link do strony nim nie jest (TSUE, C-49/11
 * Content Services), plik w mailu — jest. Dlatego treść żyje jako dane:
 * strona WWW renderuje ją komponentem (`components/legal/legal-document.tsx`),
 * a mail z potwierdzeniem dostaje ten sam tekst jako załącznik (`renderPlainText`).
 * Dwie kopie tekstu w dwóch miejscach rozjechałyby się przy pierwszej poprawce.
 *
 * Znaczniki w tekście (celowo tylko dwa):
 *   **pogrubienie**
 *   [etykieta](/sciezka-albo-https://adres)
 */

/** Element listy: sam tekst albo tekst z podpunktami. */
export interface ListItem {
  text: string;
  items?: ListEntry[];
}
export type ListEntry = string | ListItem;

export type Block =
  | { type: 'p'; text: string }
  /** Numerowana: ustępy „1.”, w nich punkty „1)”, w nich litery „a)”. */
  | { type: 'ol'; items: ListEntry[] }
  | { type: 'ul'; items: ListEntry[] }
  | { type: 'table'; head: string[]; rows: string[][] }
  /** Ramka „ważne” — np. informacja o prawie odstąpienia. */
  | { type: 'note'; text: string };

export interface DocSection {
  /** Kotwica w adresie (#id) — stała, bo linkują do niej inne dokumenty. */
  id: string;
  /** „§ 3. Rejestracja” albo „3. Cele przetwarzania”. */
  title: string;
  blocks: Block[];
}

export interface LegalDocument {
  slug: string;
  title: string;
  /** Wersja = data przyjęcia treści (RRRR-MM-DD). Zmiana treści = nowa wersja. */
  version: string;
  /** Krótkie streszczenie po ludzku — NIE jest częścią wiążącej treści. */
  summary?: string[];
  sections: DocSection[];
}

// ─── budowniczowie (żeby treść dokumentów była czytelna) ──────────────

export const p = (text: string): Block => ({ type: 'p', text });
export const note = (text: string): Block => ({ type: 'note', text });
export const ol = (...items: ListEntry[]): Block => ({ type: 'ol', items });
export const ul = (...items: ListEntry[]): Block => ({ type: 'ul', items });
export const li = (text: string, ...items: ListEntry[]): ListItem => ({ text, items });
export const table = (head: string[], rows: string[][]): Block => ({ type: 'table', head, rows });
export const section = (id: string, title: string, ...blocks: Block[]): DocSection => ({
  id,
  title,
  blocks,
});

// ─── znaczniki w tekście ──────────────────────────────────────────────

export type InlineToken =
  | { kind: 'text'; value: string }
  | { kind: 'bold'; value: string }
  | { kind: 'link'; value: string; href: string };

/**
 * Rozbija tekst na kawałki. Bez wyrażeń budowanych z danych i bez HTML:
 * treść pochodzi z repozytorium, a renderer i tak wstawia ją jako tekst.
 */
export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let rest = text;
  const pushText = (value: string) => {
    if (value) tokens.push({ kind: 'text', value });
  };
  while (rest.length > 0) {
    const boldAt = rest.indexOf('**');
    const linkAt = rest.indexOf('[');
    const candidates = [boldAt, linkAt].filter((i) => i >= 0);
    if (candidates.length === 0) {
      pushText(rest);
      break;
    }
    const at = Math.min(...candidates);
    if (at === boldAt) {
      const end = rest.indexOf('**', at + 2);
      if (end < 0) {
        pushText(rest);
        break;
      }
      pushText(rest.slice(0, at));
      tokens.push({ kind: 'bold', value: rest.slice(at + 2, end) });
      rest = rest.slice(end + 2);
      continue;
    }
    // Etykieta kończy się na PIERWSZYM „]”; link tylko wtedy, gdy zaraz po
    // nim stoi „(”. Szukanie „](” w dalszej części tekstu wciągało do linku
    // wszystko od nawiasu pola „[DO UZUPEŁNIENIA: …]” (rewizja 15.10.2026).
    const closeLabel = rest.indexOf(']', at);
    const isLink = closeLabel >= 0 && rest[closeLabel + 1] === '(';
    const closeHref = isLink ? rest.indexOf(')', closeLabel + 2) : -1;
    if (!isLink || closeHref < 0) {
      // Zwykły nawias kwadratowy w tekście (np. „[DO UZUPEŁNIENIA: …]”).
      pushText(rest.slice(0, at + 1));
      rest = rest.slice(at + 1);
      continue;
    }
    pushText(rest.slice(0, at));
    tokens.push({
      kind: 'link',
      value: rest.slice(at + 1, closeLabel),
      href: rest.slice(closeLabel + 2, closeHref),
    });
    rest = rest.slice(closeHref + 1);
  }
  // Sklej sąsiednie kawałki tekstu (po nawiasach bez linku).
  const merged: InlineToken[] = [];
  for (const t of tokens) {
    const last = merged[merged.length - 1];
    if (t.kind === 'text' && last?.kind === 'text') last.value += t.value;
    else merged.push({ ...t });
  }
  return merged;
}

// ─── numeracja ────────────────────────────────────────────────────────

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** Etykieta pozycji: poziom 0 „1.”, poziom 1 „1)”, poziom 2 „a)”. */
export function listLabel(depth: number, index: number): string {
  if (depth === 0) return `${index + 1}.`;
  if (depth === 1) return `${index + 1})`;
  return `${LETTERS[index % LETTERS.length]})`;
}

export function entryText(entry: ListEntry): string {
  return typeof entry === 'string' ? entry : entry.text;
}

export function entryChildren(entry: ListEntry): ListEntry[] {
  return typeof entry === 'string' ? [] : (entry.items ?? []);
}

// ─── wersja tekstowa (załącznik do maila, pobranie) ───────────────────

function plainInline(text: string, siteUrl: string): string {
  return parseInline(text)
    .map((t) => {
      if (t.kind !== 'link') return t.value;
      // Kotwica w tym samym dokumencie nic nie mówi w pliku — sama etykieta.
      if (t.href.startsWith('#')) return t.value;
      const href = t.href.startsWith('/') ? `${siteUrl}${t.href}` : t.href;
      return href === t.value ? t.value : `${t.value} (${href})`;
    })
    .join('');
}

function plainList(
  items: ListEntry[],
  ordered: boolean,
  depth: number,
  siteUrl: string,
  out: string[],
  indent: string,
) {
  items.forEach((entry, i) => {
    const label = ordered ? listLabel(depth, i) : '–';
    out.push(`${indent}${label} ${plainInline(entryText(entry), siteUrl)}`);
    const children = entryChildren(entry);
    // Podpunkty listy numerowanej numerujemy dalej; wypunktowania zostają myślnikami.
    if (children.length > 0) plainList(children, ordered, depth + 1, siteUrl, out, `${indent}   `);
  });
}

export function renderPlainText(doc: LegalDocument, siteUrl: string, header?: string[]): string {
  const out: string[] = [];
  if (header) out.push(...header, '');
  out.push(doc.title.toUpperCase(), `Wersja z dnia ${doc.version}`, '');
  for (const s of doc.sections) {
    out.push(s.title, '');
    for (const b of s.blocks) {
      switch (b.type) {
        case 'p':
          out.push(plainInline(b.text, siteUrl));
          break;
        case 'note':
          out.push(`>> ${plainInline(b.text, siteUrl)}`);
          break;
        case 'ol':
          plainList(b.items, true, 0, siteUrl, out, '');
          break;
        case 'ul':
          plainList(b.items, false, 0, siteUrl, out, '');
          break;
        case 'table':
          out.push(b.head.map((h) => plainInline(h, siteUrl)).join(' | '));
          for (const row of b.rows) out.push(row.map((c) => plainInline(c, siteUrl)).join(' | '));
          break;
      }
      out.push('');
    }
  }
  // CRLF: Notatnik w starszym Windows pokazuje plik z samym LF jako jedną linię.
  return out.join('\r\n');
}
