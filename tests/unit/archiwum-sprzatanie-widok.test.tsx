import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 6.4, część 2: ustawienia firmy (`/settings#archiwum`) po usunięciu
 * pliku wygasłej paczki z magazynu (00190). Paczka zostaje na liście jako
 * historia: wygasła, z usuniętym plikiem, bez przycisku „Pobierz”, a nową
 * paczkę da się zlecić. Komponent prawdziwy; podstawione są tylko router
 * Next i akcje serwerowe (`'use server'` ciągnie backend).
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ prefetch: () => {}, push: () => {}, refresh: () => {}, replace: () => {} }),
}));
vi.mock('@/app/actions/archiwum', () => ({
  getDocumentArchiveLinkAction: vi.fn(),
  requestDocumentArchiveAction: vi.fn(),
}));

const { DocumentArchiveForm } = await import('@/components/settings/document-archive-form');
type Order = Parameters<typeof DocumentArchiveForm>[0]['orders'][number];

const base = {
  kind: 'archive',
  status: 'completed',
  created_at: '2026-11-09T10:00:00Z',
  finished_at: '2026-11-09T10:05:00Z',
  size_bytes: 2048,
  files_count: 5,
  missing_count: 0,
  error_message: null,
} as const;

const usunieta = {
  ...base,
  id: '0190dddd-0000-4000-8000-000000000001',
  period_start: '2026-03-01',
  period_end: '2026-03-31',
  expires_at: '2026-11-16T10:05:00Z',
  file_deleted_at: '2026-11-17T03:30:00Z',
} as unknown as Order;
const wygaslaPrzedSprzataniem = {
  ...base,
  id: '0190dddd-0000-4000-8000-000000000002',
  period_start: '2026-04-01',
  period_end: '2026-04-30',
  expires_at: '2026-11-20T08:30:00Z',
  file_deleted_at: null,
} as unknown as Order;
const gotowa = {
  ...base,
  id: '0190dddd-0000-4000-8000-000000000003',
  period_start: '2026-05-01',
  period_end: '2026-05-31',
  expires_at: '2026-11-25T10:00:00Z',
  file_deleted_at: null,
} as unknown as Order;

function render(orders: Order[]) {
  return renderToStaticMarkup(<DocumentArchiveForm canRequest orders={orders} today="2026-11-20" />);
}

/** Wiersze listy „Ostatnie paczki” w kolejności. */
const items = (html: string) => html.split('<li').slice(1);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-20T09:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ustawienia: paczka z usuniętym plikiem', () => {
  it('wygasła paczka z usuniętym plikiem: stan zwykłym tekstem, bez „Pobierz”; nową paczkę da się zlecić', () => {
    const html = render([usunieta, wygaslaPrzedSprzataniem, gotowa]);
    const [deleted, expired, ready] = items(html);

    expect(text(deleted!)).toContain('Link wygasł 16.11.2026, a plik paczki usunęliśmy. Zleć paczkę ponownie.');
    expect(deleted).not.toContain('<button');
    // Przed przebiegiem sprzątania: wygasła, ale plik jeszcze jest (bez słowa o usunięciu).
    expect(text(expired!)).toContain('Link wygasł 20.11.2026. Zleć paczkę ponownie.');
    expect(expired).not.toContain('<button');
    expect(ready).toContain('<button');
    expect(text(ready!)).toContain('Pobierz');

    // Zlecenie nowej paczki działa jak zawsze (przycisk aktywny).
    const orderButton = /<button([^>]*)>(?:(?!<\/button>)[\s\S])*Pobierz archiwum/.exec(html);
    expect(orderButton).not.toBeNull();
    // Atrybut `disabled` (klasy Tailwinda `disabled:…` się nie liczą).
    expect(orderButton![1]).not.toMatch(/\sdisabled(=""|\s|$)/);
    expect(text(html)).not.toMatch(/[—–]/);
  });

  it('opis sekcji mówi, że po wygaśnięciu linku plik paczki usuwamy, a dokumenty zostają w FaktWay', () => {
    const html = render([]);
    expect(text(html)).toContain('link do pobrania działa 7 dni. Potem usuwamy plik paczki, a dokumenty zostają w FaktWay.');
  });
});
