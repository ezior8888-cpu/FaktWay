import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ctx = vi.hoisted(() => ({ get: vi.fn(), read: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/lib/supabase/page-context', () => ({ getPageContext: ctx.get }));
vi.mock('@/lib/ksef/history-sync/status', () => ({ readKsefHistorySyncStatus: ctx.read }));
// Akcje serwera (import pliku, wstrzymanie) — tu tylko render, bez kolejki i bazy.
vi.mock('@/app/actions/import-danych', () => ({
  startFileImportAction: vi.fn(),
  skipImportStepAction: vi.fn(),
  setKsefHistoryPausedAction: vi.fn(),
}));

import ImportDanychPage from '@/app/(dashboard)/import-danych/page';
import { ImportCenter, importStats, showsImportStats } from '@/components/import-danych/import-center';
import { KsefHistoryCard } from '@/components/import-danych/ksef-history-card';
import {
  blockedReasonText,
  certificateState,
  deferredReasonText,
  errorMessage,
  exportNotice,
  historyBadge,
  needsClientAction,
  pauseErrorFromParam,
  phaseLines,
  progressInfo,
  rateLimitText,
  rateLines,
  retiredDraftLine,
} from '@/components/import-danych/ksef-history-model';
import type { ImportHistoryJob } from '@/components/import-danych/import-model';
import type {
  KsefHistoryBlockedItem,
  KsefHistoryBlockedReason,
  KsefHistoryDeferredItem,
  KsefHistoryDirection,
  KsefHistoryErrorCode,
  KsefHistoryStreamStatus,
  KsefHistorySyncStatus,
} from '@/lib/ksef/history-sync/status';
import { SUPPORT_EMAIL } from '@/lib/site';

import { tekstBezZnacznikow } from './helpers/tekst-html';

/**
 * Decyzja Bartosza 22.10.2026: Magiczny import znika — FaktWay sam pobiera
 * z KSeF całą historię sprzedaży i zakupów, a potem na bieżąco sprzedaż
 * wystawioną poza FaktWay. Karta „Historia z KSeF” na ekranie Import danych
 * mówi tylko to, co pokazują dane: faza z `readKsefHistorySyncStatus`,
 * postęp z liczników, tempo i koniec dopiero z pomiaru, każdy powód
 * odłożenia albo blokady z wyjściem (link, adres pomocy albo „sprawdzamy to”).
 */

// 22.10.2026, 12:30 w Polsce (CEST).
const NOW = new Date('2026-10-22T10:30:00Z');
const FLOOR = '2022-01-01T00:00:00.000Z';

const counts = (patch: Partial<KsefHistoryStreamStatus['counts']> = {}): KsefHistoryStreamStatus['counts'] => ({
  pending: 0,
  imported: 0,
  repaired: 0,
  skipped: 0,
  retiredDraft: 0,
  deferred: 0,
  blocked: 0,
  ...patch,
});

function stream(direction: KsefHistoryDirection, patch: Partial<KsefHistoryStreamStatus> = {}): KsefHistoryStreamStatus {
  return {
    direction,
    phase: 'searching',
    enabledAt: '2026-10-22T08:00:00Z',
    historyFloor: FLOOR,
    coveredFrom: '2026-07-24T08:00:00Z',
    backfillCompletedAt: null,
    capacityReached: false,
    stuck: false,
    lastSuccessAt: '2026-10-22T10:15:00Z',
    counts: counts(),
    measuredPerHour: null,
    estimatedFinishAt: null,
    ...patch,
  };
}

function syncStatus(patch: Partial<KsefHistorySyncStatus> = {}): KsefHistorySyncStatus {
  return {
    environment: 'test',
    outgoing: stream('outgoing'),
    incoming: stream('incoming'),
    rateLimitedUntil: null,
    clientPausedAt: null,
    error: null,
    blocked: [],
    blockedTotal: 0,
    deferred: [],
    deferredTotal: 0,
    periodsChangedAfterExport: [],
    ...patch,
  };
}

const base = {
  ksefNumber: '1234567890-20261005-ABCDEF0123-01',
  direction: 'outgoing' as const,
  invoiceNumber: 'FV/10/2026',
  issueDate: '2026-10-05',
  counterpartyName: 'Kontrahent Testowy sp. z o.o.',
  grossAmount: 1230,
  currency: 'PLN',
  localInvoiceId: 'inv-1',
  updatedAt: '2026-10-22T09:00:00Z',
};
const blockedItem = (reason: KsefHistoryBlockedReason, patch: Partial<KsefHistoryBlockedItem> = {}): KsefHistoryBlockedItem => ({
  ...base,
  reason,
  ...patch,
});
const deferredItem = (
  reason: KsefHistoryDeferredItem['reason'],
  patch: Partial<KsefHistoryDeferredItem> = {},
): KsefHistoryDeferredItem => ({ ...base, reason, ...patch });

const text = (html: string) => tekstBezZnacznikow(html).replace(/\s+/g, ' ');

function card(props: Partial<Parameters<typeof KsefHistoryCard>[0]> = {}) {
  return renderToStaticMarkup(
    <KsefHistoryCard
      hasCertificate
      certificateConfirmed
      status={syncStatus()}
      isOwner
      pauseError={null}
      now={NOW}
      {...props}
    />,
  );
}

describe('fazy sekcji „Sprzedaż” i „Zakupy”', () => {
  const opts = { outgoingEnabledAt: '2026-10-22T10:00:00Z', paused: false, blocked: false, now: NOW };

  it('oczekiwanie: sprzedaż w 30 minut, zakupy po Skrzynce; po godzinie bez Skrzynki — „sprawdzamy to”', () => {
    expect(phaseLines(stream('outgoing', { phase: 'waiting', coveredFrom: null }), opts)).toEqual([
      'Zaczniemy w ciągu 30 minut od wgrania certyfikatu.',
    ]);
    expect(phaseLines(stream('incoming', { phase: 'waiting', coveredFrom: null }), opts)).toEqual([
      'Zaczniemy po pierwszym pobraniu Skrzynki KSeF.',
    ]);
    expect(
      phaseLines(stream('incoming', { phase: 'waiting', coveredFrom: null }), { ...opts, outgoingEnabledAt: '2026-10-22T09:00:00Z' }),
    ).toEqual([
      'Zaczniemy po pierwszym pobraniu Skrzynki KSeF.',
      'Skrzynka KSeF jeszcze się nie połączyła — sprawdzamy to, nic nie musisz robić.',
    ]);
  });

  it('szukanie: od kiedy przeszukaliśmy (czas polski) i „szukamy dalej wstecz”', () => {
    expect(phaseLines(stream('outgoing'), opts)).toEqual([
      'Przeszukaliśmy KSeF od 24.07.2026 do dziś.',
      'Szukamy dalej wstecz.',
    ]);
  });

  it('pobieranie: cała historia znaleziona, zostaje pending + deferred', () => {
    const s = stream('outgoing', { phase: 'downloading', counts: counts({ pending: 10, deferred: 2, imported: 40 }) });
    expect(phaseLines(s, opts)).toEqual(['Znaleźliśmy całą historię w KSeF — pobieramy jeszcze 12 faktur.']);
    const one = stream('outgoing', { phase: 'downloading', counts: counts({ pending: 1 }) });
    expect(phaseLines(one, opts)).toEqual(['Znaleźliśmy całą historię w KSeF — pobieramy jeszcze 1 fakturę.']);
  });

  it('sprzedaż na bieżąco i zakupy pobrane (archiwum bez kosztów)', () => {
    expect(phaseLines(stream('outgoing', { phase: 'live' }), opts)).toEqual([
      'Cała historia sprzedaży pobrana. Nowe faktury wystawione poza FaktWay pobieramy automatycznie, zwykle w ciągu godziny.',
    ]);
    expect(phaseLines(stream('incoming', { phase: 'done' }), opts)).toEqual([
      'Historia zakupów pobrana. Nowe faktury zakupowe trafiają do Skrzynki KSeF co 15 minut. Faktury z historii zapisujemy jako archiwum — nie dodajemy ich do kosztów.',
    ]);
  });

  it('bardzo duża historia: ile najnowszych pobraliśmy i gdzie napisać po starsze', () => {
    const s = stream('outgoing', { phase: 'live', capacityReached: true, counts: counts({ imported: 25000 }) });
    // Polski separator tysięcy to twarda spacja (U+00A0).
    expect(phaseLines(s, opts).map((line) => line.replace(/ /g, ' '))).toEqual([
      `Twoja historia w KSeF jest bardzo duża — pobraliśmy 25 000 najnowszych faktur. Po starsze napisz na ${SUPPORT_EMAIL}.`,
    ]);
  });

  it('wstrzymane: bez „szukamy dalej” i bez „pobieramy automatycznie”; zakupy (Skrzynka) bez zmian', () => {
    const paused = { ...opts, paused: true };
    expect(phaseLines(stream('outgoing'), paused)).toEqual(['Przeszukaliśmy KSeF od 24.07.2026 do dziś.']);
    expect(phaseLines(stream('outgoing', { phase: 'downloading', counts: counts({ pending: 3 }) }), paused)).toEqual([
      'Znaleźliśmy całą historię w KSeF.',
    ]);
    expect(phaseLines(stream('outgoing', { phase: 'live' }), paused)).toEqual(['Cała historia sprzedaży pobrana.']);
    expect(phaseLines(stream('outgoing', { phase: 'waiting', coveredFrom: null }), paused)).toEqual(['Pobieranie wstrzymane.']);
    expect(phaseLines(stream('incoming', { phase: 'done' }), paused)[0]).toMatch(/^Historia zakupów pobrana\./);
  });
});

describe('postęp, tempo i szacowany koniec', () => {
  it('postęp: brak, gdy nic nie znaleźliśmy; „co najmniej” w trakcie szukania; naprawione się nie liczą', () => {
    expect(progressInfo(stream('outgoing'))).toBeNull();
    expect(progressInfo(stream('outgoing', { phase: 'downloading', counts: counts({ imported: 30, pending: 8, deferred: 2, repaired: 7 }) }))).toEqual({
      imported: 30,
      total: 40,
      percent: 75,
      label: 'Pobrano 30 z 40 faktur',
    });
    expect(progressInfo(stream('outgoing', { counts: counts({ imported: 5, pending: 7 }) }))?.label).toBe(
      'Pobrano 5 z co najmniej 12 faktur',
    );
    expect(progressInfo(stream('incoming', { phase: 'downloading', counts: counts({ pending: 1 }) }))?.label).toBe('Pobrano 0 z 1 faktury');
  });

  it('tempo zmierzone + koniec tylko przy pobieraniu; w trakcie szukania „koniec oszacujemy”', () => {
    const downloading = stream('outgoing', {
      phase: 'downloading',
      measuredPerHour: 18,
      estimatedFinishAt: '2026-10-23T07:05:00Z',
      counts: counts({ pending: 300 }),
    });
    expect(rateLines(downloading, false)).toEqual([
      'Pobieramy ok. 18 faktur na godzinę, żeby nie przekroczyć limitów KSeF.',
      'Szacowany koniec: 23.10 o 09:05.',
    ]);
    const searching = stream('outgoing', { measuredPerHour: 22, counts: counts({ pending: 50 }) });
    expect(rateLines(searching, false)).toEqual([
      'Pobieramy ok. 22 faktury na godzinę, żeby nie przekroczyć limitów KSeF.',
      'Koniec oszacujemy, gdy przeszukamy całą historię.',
    ]);
  });

  it('same faktury odłożone: bez „pobieramy” i bez tempa (zostały tylko do wyjaśnienia)', () => {
    const onlyDeferred = stream('outgoing', {
      phase: 'downloading',
      measuredPerHour: 18,
      estimatedFinishAt: '2026-10-23T07:05:00Z',
      counts: counts({ pending: 0, deferred: 3 }),
    });
    expect(rateLines(onlyDeferred, false)).toEqual([]);
    expect(phaseLines(onlyDeferred, { outgoingEnabledAt: null, paused: false, blocked: false, now: new Date('2026-10-22T10:00:00Z') }).join(' ')).not.toMatch(/pobieramy/i);
    expect(phaseLines(onlyDeferred, { outgoingEnabledAt: null, paused: false, blocked: false, now: new Date('2026-10-22T10:00:00Z') }).join(' ')).toContain('do wyjaśnienia');
  });

  it('bez pomiaru: „powoli”, gdy coś czeka; nic, gdy nic nie czeka, przy wstrzymaniu i po pobraniu', () => {
    expect(rateLines(stream('outgoing', { counts: counts({ pending: 4 }) }), false)).toEqual([
      'Pobieramy faktury powoli, żeby nie przekroczyć limitów KSeF.',
    ]);
    expect(rateLines(stream('outgoing'), false)).toEqual([]);
    expect(rateLines(stream('outgoing', { measuredPerHour: 20, counts: counts({ pending: 4 }) }), true)).toEqual([]);
    expect(rateLines(stream('outgoing', { phase: 'live', measuredPerHour: 20 }), false)).toEqual([]);
  });
});

describe('komunikaty całej firmy', () => {
  it('ograniczenie tempa przez KSeF: dziś „o GG:MM”, innego dnia z datą, minione — nic', () => {
    expect(rateLimitText('2026-10-22T11:00:00Z', NOW)).toBe('KSeF ograniczył tempo pobierania. Wznowimy o 13:00.');
    expect(rateLimitText('2026-10-23T07:00:00Z', NOW)).toBe('KSeF ograniczył tempo pobierania. Wznowimy 23.10 o 09:00.');
    expect(rateLimitText('2026-10-22T10:00:00Z', NOW)).toBeNull();
    expect(rateLimitText(null, NOW)).toBeNull();
  });

  it('pięć kodów błędu: trzy z linkiem do ustawień KSeF, dwa „ponowimy / sprawdzamy”', () => {
    const at = '2026-10-22T09:00:00Z';
    expect(errorMessage({ code: 'credentials', at, certificateExpiry: null })).toEqual({
      text: 'KSeF nie przyjął certyfikatu. Wgraj aktualny certyfikat — pobieranie wznowi się samo.',
      settingsLink: true,
      tone: 'destructive',
    });
    expect(errorMessage({ code: 'certificate_expired', at, certificateExpiry: '2026-10-20T00:00:00Z' })?.text).toBe(
      'Certyfikat KSeF wygasł 20.10.2026. Wgraj nowy — pobieranie wznowi się samo.',
    );
    expect(errorMessage({ code: 'permission', at, certificateExpiry: null })).toMatchObject({
      text: 'Certyfikat nie ma uprawnienia do przeglądania faktur w KSeF. Nadaj je w Aplikacji Podatnika KSeF albo wgraj certyfikat właściciela.',
      settingsLink: true,
    });
    expect(errorMessage({ code: 'ksef_unavailable', at, certificateExpiry: null })).toMatchObject({
      text: 'KSeF chwilowo nie odpowiada. Ponowimy automatycznie.',
      settingsLink: false,
    });
    expect(errorMessage({ code: 'internal', at, certificateExpiry: null })).toMatchObject({
      text: 'Pobieranie historii stoi. Dostaliśmy alarm i to sprawdzamy — nic nie musisz robić.',
      settingsLink: false,
    });
    expect(errorMessage(null)).toBeNull();
  });

  it('eksport sprzed nowych faktur: okresy MM.RRRR z liczbą, najnowsze pierwsze', () => {
    const notice = exportNotice([
      { period: '2026-09', count: 3 },
      { period: '2026-08', count: 1 },
    ]);
    expect(notice && `${notice.lead}${notice.regenerate}${notice.rest}`).toBe(
      'Po Twoim eksporcie doszły faktury z KSeF za okresy: 09.2026 (3), 08.2026 (1). Wygeneruj eksport ponownie; jeśli JPK za te okresy jest już wysłany, sprawdź z księgowym, czy potrzebna jest korekta.',
    );
    expect(exportNotice([])).toBeNull();
  });

  it('plakietka: bez certyfikatu, wstrzymane, automatycznie', () => {
    expect(historyBadge('missing', syncStatus()).label).toBe('Wymaga certyfikatu');
    expect(historyBadge('ready', syncStatus({ clientPausedAt: '2026-10-21T08:00:00Z' })).label).toBe('Wstrzymane');
    expect(historyBadge('ready', syncStatus()).label).toBe('Automatycznie');
    expect(historyBadge('ready', null).label).toBe('Automatycznie');
  });

  it('wycofane szkice przy duplikacie: odmiana 1 / 3 / 5', () => {
    const withRetired = (n: number) =>
      syncStatus({ outgoing: stream('outgoing', { counts: counts({ retiredDraft: n }) }) });
    expect(retiredDraftLine(syncStatus())).toBeNull();
    expect(retiredDraftLine(withRetired(1))).toBe(
      '1 faktura z KSeF ma numer zajęty przez dokument wycofany przy duplikacie — nie przenosimy jej, żeby nie zdublować sprzedaży.',
    );
    expect(retiredDraftLine(withRetired(3))).toBe(
      '3 faktury z KSeF mają numer zajęty przez dokument wycofany przy duplikacie — nie przenosimy ich, żeby nie zdublować sprzedaży.',
    );
    expect(retiredDraftLine(withRetired(5))).toBe(
      '5 faktur z KSeF ma numer zajęty przez dokument wycofany przy duplikacie — nie przenosimy ich, żeby nie zdublować sprzedaży.',
    );
  });
});

describe('powody odłożenia i blokady — każdy z wyjściem', () => {
  it('odłożone: decyzja przy duplikacie z linkiem do dokumentu, własna wysyłka bez linku', () => {
    expect(deferredReasonText(deferredItem('duplicate_decision'))).toEqual({
      text: 'Ta faktura jest w KSeF, a w FaktWay czeka na Twoją decyzję przy duplikacie.',
      invoiceHref: '/invoices/inv-1',
      mentionsSupport: false,
    });
    expect(deferredReasonText(deferredItem('own_send_pending'))).toEqual({
      text: 'To prawdopodobnie faktura wysłana właśnie z FaktWay — sprawdzimy ją ponownie za godzinę.',
      invoiceHref: null,
      mentionsSupport: false,
    });
  });

  it('niepobrane: waluta, szkic, plik, zajęty numer, własna wysyłka — teksty i linki', () => {
    expect(blockedReasonText(blockedItem('currency_not_supported', { currency: 'EUR' }))).toMatchObject({
      text: 'Faktura w walucie EUR. FaktWay nie przenosi jeszcze z KSeF faktur walutowych — oryginał zostaje w KSeF.',
      invoiceHref: null,
    });
    expect(blockedReasonText(blockedItem('number_conflict'))).toEqual({
      text: 'W FaktWay jest szkic o numerze FV/10/2026, np. z importu pliku. Szkic nie liczy się w przychodzie ani w KPiR — usuń go, a pobierzemy oryginał z KSeF sami.',
      invoiceHref: '/invoices/inv-1',
      mentionsSupport: false,
    });
    expect(blockedReasonText(blockedItem('file_import_mismatch'))).toEqual({
      text: 'W FaktWay jest faktura FV/10/2026 przeniesiona z pliku, ale z innymi danymi niż w KSeF (kontrahent, data albo kwota). Sprawdzamy to — nie zmieniaj jej.',
      invoiceHref: '/invoices/inv-1',
      mentionsSupport: false,
    });
    expect(blockedReasonText(blockedItem('number_taken_local'))).toEqual({
      text: 'W FaktWay jest już dokument o numerze FV/10/2026 z innym numerem KSeF. Nie zmieniaj go — sprawdzamy to.',
      invoiceHref: '/invoices/inv-1',
      mentionsSupport: false,
    });
    expect(blockedReasonText(blockedItem('number_conflict', { localInvoiceId: null })).invoiceHref).toBeNull();
    expect(blockedReasonText(blockedItem('own_send_unresolved'))).toEqual({
      text: 'To prawdopodobnie faktura wysłana z FaktWay, której wynik jeszcze uzgadniamy. Nie wystawiaj jej ponownie.',
      invoiceHref: null,
      mentionsSupport: false,
    });
  });

  it.each([
    'parse_failed',
    'local_conflict',
    'save_failed',
    'repair_failed',
    'download_failed',
    'archive_conflict',
    'metadata_mismatch',
  ] as const)('niepobrane (%s): „sprawdzamy to” i adres pomocy', (reason) => {
    expect(blockedReasonText(blockedItem(reason))).toEqual({
      text: `Nie udało się jej zapisać. Sprawdzamy to — jeśli potrzebujesz jej pilnie, napisz na ${SUPPORT_EMAIL}.`,
      invoiceHref: null,
      mentionsSupport: true,
    });
  });
});

describe('karta „Historia z KSeF”', () => {
  it('bez certyfikatu: zaproszenie do wgrania, link do ustawień KSeF, liczba już pobranych, bez wstrzymania', () => {
    const html = card({
      hasCertificate: false,
      status: syncStatus({ outgoing: stream('outgoing', { counts: counts({ imported: 9, repaired: 4 }) }), incoming: stream('incoming', { counts: counts({ imported: 3 }) }) }),
    });
    const t = text(html);
    expect(t).toContain('Historia z KSeF');
    expect(t).toContain('Wymaga certyfikatu');
    expect(t).toContain('Wgraj certyfikat KSeF — całą historię sprzedaży i zakupów pobierzemy sami.');
    // Naprawione (`repaired`) to nie nowe faktury.
    expect(t).toContain('Do tej pory pobraliśmy 12 faktur.');
    expect(html).toContain('href="/settings/ksef"');
    expect(t).not.toContain('Wstrzymaj pobieranie historii');
    expect(t).not.toContain('Przeszukaliśmy');

    const empty = text(card({ hasCertificate: false, status: syncStatus() }));
    expect(empty).not.toContain('Do tej pory');
  });

  it('stanu nie da się wczytać: komunikat i „Odśwież”, bez liczb i bez wstrzymania', () => {
    const html = card({ status: null });
    expect(text(html)).toContain('Nie udało się wczytać stanu pobierania z KSeF.');
    expect(html).toMatch(/href="\/import-danych"[^>]*>Odśwież<\/a>/);
    expect(text(html)).not.toContain('Wstrzymaj pobieranie historii');
    expect(text(html)).not.toContain('Pobrano');
  });

  it('w toku: obie sekcje, postęp z belką, tempo, ostatnie pobranie, notka o należnościach', () => {
    const html = card({
      status: syncStatus({
        outgoing: stream('outgoing', {
          phase: 'downloading',
          measuredPerHour: 18,
          estimatedFinishAt: '2026-10-23T07:05:00Z',
          counts: counts({ imported: 30, pending: 10 }),
        }),
        incoming: stream('incoming', { phase: 'waiting', coveredFrom: null }),
      }),
    });
    const t = text(html);
    expect(t).toContain('Automatycznie');
    expect(t).toContain('Ostatnie pobranie: 22.10.2026, 12:15');
    expect(t).toContain('Sprzedaż');
    expect(t).toContain('Zakupy');
    expect(t).toContain('Znaleźliśmy całą historię w KSeF — pobieramy jeszcze 10 faktur.');
    expect(t).toContain('Pobrano 30 z 40 faktur');
    expect(html).toContain('role="progressbar"');
    expect(t).toContain('Pobieramy ok. 18 faktur na godzinę, żeby nie przekroczyć limitów KSeF.');
    expect(t).toContain('Szacowany koniec: 23.10 o 09:05.');
    expect(t).toContain('Zaczniemy po pierwszym pobraniu Skrzynki KSeF.');
    expect(t).toContain(
      'Faktur wystawionych poza FaktWay nie liczymy w należnościach i nie wysyłamy do nich przypomnień o płatności.',
    );
  });

  it('notka o należnościach tylko, gdy pobraliśmy sprzedaż', () => {
    expect(text(card())).not.toContain('nie liczymy w należnościach');
    const onlyPurchases = syncStatus({ incoming: stream('incoming', { phase: 'done', counts: counts({ imported: 50 }) }) });
    expect(text(card({ status: onlyPurchases }))).not.toContain('nie liczymy w należnościach');
  });

  it('pobieranie stoi: zdanie w sekcji; przy błędzie „internal” jedno zdanie dla całej firmy', () => {
    const stuck = syncStatus({ outgoing: stream('outgoing', { stuck: true }) });
    const t = text(card({ status: stuck }));
    expect(t.split('Pobieranie historii stoi.').length - 1).toBe(1);

    const internal = syncStatus({
      outgoing: stream('outgoing', { stuck: true }),
      incoming: stream('incoming', { stuck: true }),
      error: { code: 'internal', at: '2026-10-22T09:00:00Z', certificateExpiry: null },
    });
    expect(text(card({ status: internal })).split('Pobieranie historii stoi.').length - 1).toBe(1);
  });

  it.each([
    ['credentials', 'KSeF nie przyjął certyfikatu. Wgraj aktualny certyfikat — pobieranie wznowi się samo.', true],
    ['certificate_expired', 'Certyfikat KSeF wygasł 20.10.2026. Wgraj nowy — pobieranie wznowi się samo.', true],
    [
      'permission',
      'Certyfikat nie ma uprawnienia do przeglądania faktur w KSeF. Nadaj je w Aplikacji Podatnika KSeF albo wgraj certyfikat właściciela.',
      true,
    ],
    ['ksef_unavailable', 'KSeF chwilowo nie odpowiada. Ponowimy automatycznie.', false],
    ['internal', 'Pobieranie historii stoi. Dostaliśmy alarm i to sprawdzamy — nic nie musisz robić.', false],
  ] as const)('błąd %s: komunikat i (gdy klient może coś zrobić) link do ustawień KSeF', (code, message, link) => {
    const html = card({
      status: syncStatus({ error: { code, at: '2026-10-22T09:00:00Z', certificateExpiry: '2026-10-20T00:00:00Z' } }),
    });
    expect(text(html)).toContain(message);
    expect(html.includes('href="/settings/ksef"')).toBe(link);
  });

  it('KSeF ograniczył tempo: godzina wznowienia; przy wstrzymaniu tego nie pokazujemy', () => {
    const limited = syncStatus({ rateLimitedUntil: '2026-10-22T11:00:00Z' });
    expect(text(card({ status: limited }))).toContain('KSeF ograniczył tempo pobierania. Wznowimy o 13:00.');
    const pausedToo = syncStatus({ rateLimitedUntil: '2026-10-22T11:00:00Z', clientPausedAt: '2026-10-21T08:00:00Z' });
    expect(text(card({ status: pausedToo }))).not.toContain('KSeF ograniczył tempo');
  });

  it('wstrzymanie: przycisk tylko dla właściciela, formularz akcji serwera z paused=1', () => {
    const owner = card({ isOwner: true });
    expect(text(owner)).toContain('Wstrzymaj pobieranie historii');
    expect(owner).toMatch(/<form[^>]*>(?:(?!<\/form>).)*name="paused" value="1"(?:(?!<\/form>).)*Wstrzymaj pobieranie historii/);
    const member = card({ isOwner: false });
    expect(text(member)).not.toContain('Wstrzymaj pobieranie historii');
    expect(member).not.toContain('name="paused"');
  });

  it('wstrzymane: data, wysyłka i Skrzynka działają; „Wznów” tylko dla właściciela; bez „szukamy dalej” i tempa', () => {
    const paused = syncStatus({
      clientPausedAt: '2026-10-21T08:00:00Z',
      outgoing: stream('outgoing', { measuredPerHour: 20, counts: counts({ pending: 5 }) }),
    });
    const owner = card({ status: paused, isOwner: true });
    const t = text(owner);
    expect(t).toContain('Wstrzymane');
    expect(t).toContain(
      'Pobieranie historii wstrzymane 21.10.2026. Wysyłka faktur z FaktWay i Skrzynka KSeF działają bez zmian.',
    );
    expect(owner).toMatch(/name="paused" value="0"(?:(?!<\/form>).)*Wznów pobieranie/);
    expect(t).not.toContain('Wstrzymaj pobieranie historii');
    expect(t).not.toContain('Szukamy dalej wstecz');
    expect(t).not.toContain('Pobieramy ok.');

    const member = card({ status: paused, isOwner: false });
    expect(text(member)).toContain('Pobieranie historii wstrzymane 21.10.2026.');
    expect(text(member)).not.toContain('Wznów pobieranie');
  });

  it('?wstrzymanie=blad: „Nie udało się zmienić ustawienia — spróbuj ponownie.”', () => {
    expect(text(card({ pauseError: 'failed' }))).toContain('Nie udało się zmienić ustawienia — spróbuj ponownie.');
    expect(text(card())).not.toContain('Nie udało się zmienić ustawienia');
  });

  it('listy w <details>: odłożone i niepobrane z powodami, linkami do dokumentów i adresem pomocy', () => {
    const html = card({
      status: syncStatus({
        deferred: [deferredItem('duplicate_decision'), deferredItem('own_send_pending', { ksefNumber: 'K-2', localInvoiceId: 'inv-2' })],
        deferredTotal: 2,
        blocked: [
          blockedItem('currency_not_supported', { ksefNumber: 'K-3', currency: 'EUR', grossAmount: 100, localInvoiceId: null }),
          blockedItem('number_conflict', { ksefNumber: 'K-4', localInvoiceId: 'inv-4' }),
          blockedItem('save_failed', { ksefNumber: 'K-5', direction: 'incoming', localInvoiceId: null }),
        ],
        blockedTotal: 57,
      }),
    });
    const t = text(html);
    expect(html).toMatch(/<details[^>]*><summary[^>]*>Czekają na rozstrzygnięcie \(2\)<\/summary>/);
    expect(html).toMatch(/<details[^>]*><summary[^>]*>Faktury, których nie pobraliśmy \(57\)<\/summary>/);
    expect(t).toContain('Ta faktura jest w KSeF, a w FaktWay czeka na Twoją decyzję przy duplikacie.');
    expect(t).toContain('To prawdopodobnie faktura wysłana właśnie z FaktWay — sprawdzimy ją ponownie za godzinę.');
    expect(t).toContain('Faktura w walucie EUR.');
    expect(t).toContain('W FaktWay jest szkic o numerze FV/10/2026, np. z importu pliku.');
    expect(t).toContain(`napisz na ${SUPPORT_EMAIL}.`);
    expect(html).toContain(`href="mailto:${SUPPORT_EMAIL}"`);
    expect(html).toContain('href="/invoices/inv-1"');
    expect(html).toContain('href="/invoices/inv-4"');
    // Własna wysyłka w toku nie ma czego otwierać — tylko „sprawdzimy za godzinę”.
    expect(html).not.toContain('href="/invoices/inv-2"');
    // Wiersz: numer, data, kontrahent, kwota, kierunek.
    expect(t).toContain('FV/10/2026 · 05.10.2026 · Kontrahent Testowy sp. z o.o. · 1230,00 zł · sprzedaż');
    expect(t).toContain('100,00 EUR');
    expect(t).toContain('· zakup');
    // Lista ucięta do 20 ostatnio sprawdzanych — mówimy, ile jest wszystkich.
    expect(t).toContain('Pokazujemy 3 ostatnio sprawdzanych z 57.');
  });

  it('bez odłożonych i niepobranych: bez list', () => {
    const html = card();
    expect(html).not.toContain('<details');
  });

  it('wycofane szkice i eksport sprzed nowych faktur', () => {
    const html = card({
      status: syncStatus({
        outgoing: stream('outgoing', { counts: counts({ retiredDraft: 5 }) }),
        periodsChangedAfterExport: [{ period: '2026-09', count: 3 }],
      }),
    });
    const t = text(html);
    expect(t).toContain(
      '5 faktur z KSeF ma numer zajęty przez dokument wycofany przy duplikacie — nie przenosimy ich, żeby nie zdublować sprzedaży.',
    );
    expect(t).toContain(
      'Po Twoim eksporcie doszły faktury z KSeF za okresy: 09.2026 (3). Wygeneruj eksport ponownie; jeśli JPK za te okresy jest już wysłany, sprawdź z księgowym, czy potrzebna jest korekta.',
    );
    expect(html).toMatch(/href="\/reports\/exports"[^>]*>Wygeneruj eksport ponownie<\/a>/);
  });

  it('bardzo duża historia i sprzedaż na bieżąco', () => {
    const t = text(
      card({
        status: syncStatus({
          outgoing: stream('outgoing', { phase: 'live', capacityReached: true, counts: counts({ imported: 25000 }) }),
          incoming: stream('incoming', { phase: 'done', counts: counts({ imported: 10 }) }),
        }),
      }),
    );
    expect(t).toContain('Twoja historia w KSeF jest bardzo duża — pobraliśmy 25 000 najnowszych faktur.');
    expect(t).toContain('Historia zakupów pobrana.');
    expect(t).not.toContain('Znaleźliśmy całą historię');
  });
});

describe('błąd certyfikatu zatrzymuje pobieranie — tekst tego nie ukrywa', () => {
  // Poprawka po przeglądzie (decyzja Bartosza 22.10.2026): przy błędzie, który
  // naprawia klient (certyfikat odrzucony, wygasły, bez uprawnienia), runner
  // nie woła KSeF wcale. Karta nie może obok czerwonego „Wgraj nowy” mówić
  // „szukamy dalej”, „pobieramy”, podawać tempa ani „nic nie musisz robić”.
  const at = '2026-10-22T09:00:00Z';
  const CLIENT_CODES = ['credentials', 'certificate_expired', 'permission'] as const;
  const opts = { outgoingEnabledAt: '2026-10-22T08:00:00Z', paused: false, blocked: true, now: NOW };
  const withError = (code: KsefHistoryErrorCode, patch: Partial<KsefHistorySyncStatus> = {}) =>
    syncStatus({ error: { code, at, certificateExpiry: '2026-10-20T00:00:00Z' }, ...patch });

  it('błędy, które naprawia klient: odrzucony certyfikat, wygasły certyfikat, brak uprawnienia', () => {
    for (const code of CLIENT_CODES) expect(needsClientAction(withError(code))).toBe(true);
    expect(needsClientAction(withError('ksef_unavailable'))).toBe(false);
    expect(needsClientAction(withError('internal'))).toBe(false);
    expect(needsClientAction(syncStatus())).toBe(false);
    expect(needsClientAction(null)).toBe(false);
  });

  it('fazy: tylko fakty — bez „szukamy dalej”, „pobieramy”, obietnicy „na bieżąco” i „nic nie musisz robić”', () => {
    expect(phaseLines(stream('outgoing'), opts)).toEqual(['Przeszukaliśmy KSeF od 24.07.2026 do dziś.']);
    expect(phaseLines(stream('outgoing', { phase: 'downloading', counts: counts({ pending: 3 }) }), opts)).toEqual([
      'Znaleźliśmy całą historię w KSeF.',
    ]);
    expect(phaseLines(stream('outgoing', { phase: 'live' }), opts)).toEqual(['Cała historia sprzedaży pobrana.']);
    expect(phaseLines(stream('outgoing', { phase: 'waiting', coveredFrom: null }), opts)).toEqual([
      'Zaczniemy, gdy rozwiążesz problem z certyfikatem opisany wyżej.',
    ]);
    // Skrzynka KSeF łączy się tym samym certyfikatem — nie mówimy, że „sprawdzamy to” ani że działa.
    expect(phaseLines(stream('incoming', { phase: 'waiting', coveredFrom: null }), opts)).toEqual([
      'Zaczniemy po pierwszym pobraniu Skrzynki KSeF.',
    ]);
    expect(phaseLines(stream('incoming', { phase: 'done' }), opts)).toEqual([
      'Historia zakupów pobrana. Faktury z historii zapisujemy jako archiwum — nie dodajemy ich do kosztów.',
    ]);
    // Bardzo duża historia to fakt — zostaje.
    expect(phaseLines(stream('outgoing', { phase: 'live', capacityReached: true, counts: counts({ imported: 3 }) }), opts)[0]).toMatch(
      /^Twoja historia w KSeF jest bardzo duża/,
    );
  });

  it('plakietka „Wymaga działania” zamiast „Automatycznie”; KSeF niedostępny i błąd po naszej stronie — bez zmian', () => {
    for (const code of CLIENT_CODES) {
      expect(historyBadge('ready', withError(code))).toEqual({ label: 'Wymaga działania', tone: 'wait' });
      // Błąd certyfikatu jest ważniejszy niż wstrzymanie — bez nowego certyfikatu nie ruszy nic.
      expect(historyBadge('ready', withError(code, { clientPausedAt: '2026-10-21T08:00:00Z' })).label).toBe('Wymaga działania');
    }
    expect(historyBadge('ready', withError('ksef_unavailable')).label).toBe('Automatycznie');
    expect(historyBadge('ready', withError('internal')).label).toBe('Automatycznie');
  });

  const FORBIDDEN = [
    'Szukamy dalej',
    'pobieramy jeszcze',
    'Pobieramy ok.',
    'Pobieramy faktury powoli',
    'Szacowany koniec',
    'Koniec oszacujemy',
    'pobieramy automatycznie',
    'nic nie musisz robić',
    'co 15 minut',
    'Automatycznie',
  ];

  const SCENARIOS: Record<string, { patch: Partial<KsefHistorySyncStatus>; fact: string }> = {
    searching: {
      patch: {
        outgoing: stream('outgoing', { measuredPerHour: 10, stuck: true, counts: counts({ imported: 5, pending: 50 }) }),
        incoming: stream('incoming', { measuredPerHour: 4, counts: counts({ pending: 5 }) }),
      },
      fact: 'Przeszukaliśmy KSeF od 24.07.2026 do dziś.',
    },
    downloading: {
      patch: {
        outgoing: stream('outgoing', {
          phase: 'downloading',
          measuredPerHour: 10,
          estimatedFinishAt: '2026-10-23T07:05:00Z',
          counts: counts({ imported: 30, pending: 5 }),
        }),
        incoming: stream('incoming', { phase: 'downloading', counts: counts({ pending: 4 }) }),
      },
      fact: 'Znaleźliśmy całą historię w KSeF.',
    },
    live: {
      patch: {
        outgoing: stream('outgoing', { phase: 'live', counts: counts({ imported: 40 }) }),
        incoming: stream('incoming', { phase: 'done', counts: counts({ imported: 7 }) }),
      },
      fact: 'Cała historia sprzedaży pobrana.',
    },
    'incoming-waiting': {
      patch: {
        outgoing: stream('outgoing', { enabledAt: '2026-10-22T08:00:00Z' }),
        incoming: stream('incoming', { phase: 'waiting', coveredFrom: null }),
      },
      fact: 'Zaczniemy po pierwszym pobraniu Skrzynki KSeF.',
    },
  };

  it.each(CLIENT_CODES.flatMap((code) => Object.keys(SCENARIOS).map((name) => [code, name] as const)))(
    'karta przy błędzie %s w stanie %s: fakt zostaje, link do ustawień jest, obietnic pobierania nie ma',
    (code, name) => {
      const scenario = SCENARIOS[name]!;
      const html = card({ status: withError(code, scenario.patch) });
      const t = text(html);
      expect(t).toContain(scenario.fact);
      expect(t).toContain(errorMessage(withError(code).error)!.text);
      expect(html).toContain('href="/settings/ksef"');
      expect(t).toContain('Wymaga działania');
      for (const phrase of FORBIDDEN) expect(t).not.toContain(phrase);
    },
  );

  it('wstrzymane z błędem certyfikatu: bez „wysyłka i Skrzynka działają” i bez „Wznowimy o …”', () => {
    for (const code of CLIENT_CODES) {
      const t = text(
        card({
          status: withError(code, { clientPausedAt: '2026-10-21T08:00:00Z', rateLimitedUntil: '2026-10-22T11:00:00Z' }),
        }),
      );
      expect(t).toContain('Pobieranie historii wstrzymane 21.10.2026.');
      expect(t).not.toContain('działają bez zmian');
      expect(t).toContain('Wymaga działania');
      expect(t).toContain('Wznów pobieranie');
    }
    const limited = text(card({ status: withError('credentials', { rateLimitedUntil: '2026-10-22T11:00:00Z' }) }));
    expect(limited).not.toContain('KSeF ograniczył tempo');
  });

  it('KSeF chwilowo niedostępny: pobieranie trwa dalej, więc „szukamy dalej” zostaje', () => {
    const t = text(card({ status: withError('ksef_unavailable') }));
    expect(t).toContain('KSeF chwilowo nie odpowiada. Ponowimy automatycznie.');
    expect(t).toContain('Szukamy dalej wstecz.');
    expect(t).toContain('Automatycznie');
  });
});

describe('certyfikat bez potwierdzenia w skonfigurowanym środowisku KSeF', () => {
  // Poprawka po przeglądzie (decyzja Bartosza 22.10.2026): cron pobiera
  // historię tylko firmom z certyfikatem potwierdzonym dla KSEF_ENV
  // (`ksef_verified_at` + `ksef_verified_environment`). Sam `has_ksef_credentials`
  // nie wystarcza — taka firma (stary certyfikat bez potwierdzenia z 00117,
  // zmiana środowiska) nigdy nie dostanie strumienia, więc karta nie może
  // obiecywać „zaczniemy w ciągu 30 minut”.
  it('stan certyfikatu: brak, bez potwierdzenia, gotowy', () => {
    expect(certificateState(false, false)).toBe('missing');
    expect(certificateState(false, true)).toBe('missing');
    expect(certificateState(true, false)).toBe('unconfirmed');
    expect(certificateState(true, true)).toBe('ready');
    expect(historyBadge('unconfirmed', syncStatus())).toEqual({ label: 'Wymaga certyfikatu', tone: 'wait' });
  });

  it('karta: „wgraj ponownie” z linkiem do ustawień KSeF; bez „Automatycznie”, „30 minut” i wstrzymania', () => {
    const html = card({
      certificateConfirmed: false,
      status: syncStatus({
        outgoing: stream('outgoing', { phase: 'waiting', coveredFrom: null, counts: counts({ imported: 4 }) }),
        incoming: stream('incoming', { phase: 'waiting', coveredFrom: null }),
      }),
    });
    const t = text(html);
    expect(t).toContain('Wymaga certyfikatu');
    expect(t).toContain(
      'Certyfikat KSeF wymaga ponownego potwierdzenia. Wgraj go jeszcze raz — wtedy zaczniemy pobierać historię faktur z KSeF.',
    );
    expect(t).toContain('Do tej pory pobraliśmy 4 faktury.');
    expect(html).toMatch(/href="\/settings\/ksef"[^>]*>(?:(?!<\/a>).)*Wgraj certyfikat ponownie<\/a>/);
    expect(t).not.toContain('Automatycznie');
    expect(t).not.toContain('Zaczniemy w ciągu 30 minut');
    expect(t).not.toContain('Wstrzymaj pobieranie historii');
  });
});

describe('wstrzymanie bez logowania dwuetapowego', () => {
  // Poprawka po przeglądzie (decyzja Bartosza 22.10.2026): właściciel bez
  // potwierdzonego 2FA nie może wstrzymać pobierania. Zamiast „spróbuj
  // ponownie” (co nigdy nie pomoże) mówimy, co włączyć, i dajemy link.
  it('parametr adresu: „blad” i „2fa”; inne wartości nic nie pokazują', () => {
    expect(pauseErrorFromParam('blad')).toBe('failed');
    expect(pauseErrorFromParam('2fa')).toBe('mfa');
    expect(pauseErrorFromParam(undefined)).toBeNull();
    expect(pauseErrorFromParam('cokolwiek')).toBeNull();
    expect(pauseErrorFromParam(['2fa', 'blad'])).toBeNull();
  });

  it('?wstrzymanie=2fa: co włączyć i link do ustawień bezpieczeństwa, bez „spróbuj ponownie”', () => {
    const html = card({ pauseError: 'mfa' });
    const t = text(html);
    expect(t).toContain('Przed wstrzymaniem albo wznowieniem pobierania włącz i potwierdź logowanie dwuetapowe.');
    expect(html).toMatch(/href="\/settings\/security"[^>]*>Ustaw logowanie dwuetapowe<\/a>/);
    expect(t).not.toContain('spróbuj ponownie');
  });
});

describe('kafle Centrum importu', () => {
  const job = (overrides: Partial<ImportHistoryJob>): ImportHistoryJob => ({
    id: 'imp-1',
    source: 'fakturownia_csv',
    direction: null,
    date_from: null,
    date_to: null,
    status: 'completed',
    progress_percent: 100,
    progress_message: null,
    invoices_imported: 0,
    contractors_created: 0,
    contractors_updated: 0,
    products_created: 0,
    warnings: [],
    source_filename: 'eksport.csv',
    created_at: '2026-10-01T08:00:00Z',
    completed_at: '2026-10-01T08:01:00Z',
    ...overrides,
  });

  it('historia z KSeF bez naprawionych + dawny ręczny import; pliki osobno; ostatnie pobranie', () => {
    const status = syncStatus({
      outgoing: stream('outgoing', { counts: counts({ imported: 30, repaired: 7 }) }),
      incoming: stream('incoming', { counts: counts({ imported: 12, repaired: 2 }) }),
    });
    const jobs = [
      job({ id: 'f1', invoices_imported: 5, contractors_created: 2 }),
      job({ id: 'k1', source: 'ksef_history', direction: 'issued', invoices_imported: 4, contractors_created: 9, source_filename: null }),
      job({ id: 'k2', source: 'ksef_history', direction: 'received', invoices_imported: 1, source_filename: null }),
    ];
    const stats = importStats(jobs, status);
    expect(stats.map((s) => [s.label, s.value, s.note])).toEqual([
      ['Historia z KSeF', '47', 'sprzedaż 34 · zakupy 13'],
      ['Zaimportowane z plików', '5', undefined],
      ['Nowi kontrahenci', '2', 'z importów plików'],
      ['Ostatnie pobranie z KSeF', '22.10.2026, 12:15', undefined],
    ]);
  });

  it('stanu KSeF nie znamy: „—” zamiast zaniżonej liczby', () => {
    const stats = importStats([job({ invoices_imported: 3 })], null);
    expect(stats[0]).toMatchObject({ label: 'Historia z KSeF', value: '—', note: 'nie udało się wczytać' });
    expect(stats[3]).toMatchObject({ label: 'Ostatnie pobranie z KSeF', value: '—' });
  });

  it('kafle: przy imporcie, przy synchronizacji albo pobranych fakturach; pierwsza wizyta bez kafli', () => {
    const waiting = syncStatus({
      outgoing: stream('outgoing', { phase: 'waiting', coveredFrom: null }),
      incoming: stream('incoming', { phase: 'waiting', coveredFrom: null }),
    });
    expect(showsImportStats([], waiting)).toBe(false);
    expect(showsImportStats([], null)).toBe(false);
    expect(showsImportStats([], syncStatus())).toBe(true);
    expect(showsImportStats([job({})], waiting)).toBe(true);

    const first = renderToStaticMarkup(
      <ImportCenter tenantId="org-1" hasCertificate certificateConfirmed jobs={[]} ksefHistory={waiting} isOwner now={NOW} />,
    );
    expect(first).not.toContain('Historia z KSeF</p>');
    const synced = renderToStaticMarkup(
      <ImportCenter tenantId="org-1" hasCertificate certificateConfirmed jobs={[]} ksefHistory={syncStatus()} isOwner now={NOW} />,
    );
    expect(synced).toContain('Zaimportowane z plików');
  });
});

describe('strona /import-danych — stan historii KSeF', () => {
  const selected: string[] = [];
  function client(tenant: Record<string, unknown>) {
    return {
      from: () => {
        const builder = {
          select: (columns: string) => {
            selected.push(columns);
            return builder;
          },
          eq: () => builder,
          order: () => builder,
          single: async () => ({ data: tenant, error: null }),
          limit: async () => ({ data: [], error: null }),
        };
        return builder;
      },
    };
  }

  // Certyfikat potwierdzony w skonfigurowanym środowisku (KSEF_ENV=test w vitest.config).
  const CONFIRMED_TENANT = {
    name: 'Firma',
    nip: '1234567890',
    has_ksef_credentials: true,
    ksef_verified_at: '2026-10-01T08:00:00Z',
    ksef_verified_environment: 'test',
  };

  beforeEach(() => {
    ctx.read.mockReset();
    selected.length = 0;
  });

  it('czyta stan klientem użytkownika dla aktywnej firmy; właściciel widzi wstrzymanie', async () => {
    const supabase = client(CONFIRMED_TENANT);
    ctx.get.mockResolvedValue({ supabase, tenantId: 'org-1', role: 'owner' });
    ctx.read.mockResolvedValue({ ok: true, status: syncStatus() });
    const html = renderToStaticMarkup(await ImportDanychPage({}));
    expect(ctx.read).toHaveBeenCalledWith(supabase, 'org-1');
    expect(text(html)).toContain('Przeszukaliśmy KSeF od 24.07.2026 do dziś.');
    expect(text(html)).toContain('Wstrzymaj pobieranie historii');
    expect(text(html)).toContain('Faktury z KSeF pobieramy automatycznie. Z poprzedniego programu przeniesiesz je plikiem.');
  });

  it('członek zespołu nie widzi przycisku wstrzymania', async () => {
    ctx.get.mockResolvedValue({
      supabase: client(CONFIRMED_TENANT),
      tenantId: 'org-1',
      role: 'member',
    });
    ctx.read.mockResolvedValue({ ok: true, status: syncStatus() });
    expect(text(renderToStaticMarkup(await ImportDanychPage({})))).not.toContain('Wstrzymaj pobieranie historii');
  });

  it('?wstrzymanie=blad pokazuje komunikat', async () => {
    ctx.get.mockResolvedValue({
      supabase: client(CONFIRMED_TENANT),
      tenantId: 'org-1',
      role: 'owner',
    });
    ctx.read.mockResolvedValue({ ok: true, status: syncStatus() });
    const html = renderToStaticMarkup(await ImportDanychPage({ searchParams: Promise.resolve({ wstrzymanie: 'blad' }) }));
    expect(text(html)).toContain('Nie udało się zmienić ustawienia — spróbuj ponownie.');
  });

  it('?wstrzymanie=2fa: co włączyć zamiast „spróbuj ponownie”', async () => {
    ctx.get.mockResolvedValue({ supabase: client(CONFIRMED_TENANT), tenantId: 'org-1', role: 'owner' });
    ctx.read.mockResolvedValue({ ok: true, status: syncStatus() });
    const html = renderToStaticMarkup(await ImportDanychPage({ searchParams: Promise.resolve({ wstrzymanie: '2fa' }) }));
    expect(text(html)).toContain('Przed wstrzymaniem albo wznowieniem pobierania włącz i potwierdź logowanie dwuetapowe.');
    expect(text(html)).not.toContain('spróbuj ponownie');
  });

  it('czyta potwierdzenie certyfikatu (data i środowisko), nie sam znacznik certyfikatu', async () => {
    ctx.get.mockResolvedValue({ supabase: client(CONFIRMED_TENANT), tenantId: 'org-1', role: 'owner' });
    ctx.read.mockResolvedValue({ ok: true, status: syncStatus() });
    await ImportDanychPage({});
    const tenantColumns = selected.find((columns) => columns.includes('has_ksef_credentials'));
    expect(tenantColumns).toContain('ksef_verified_at');
    expect(tenantColumns).toContain('ksef_verified_environment');
  });

  it.each([
    ['bez potwierdzenia (stary certyfikat)', { ksef_verified_at: null, ksef_verified_environment: null }],
    ['potwierdzony w innym środowisku KSeF', { ksef_verified_environment: 'production' }],
  ])('certyfikat %s: „wgraj ponownie” zamiast „zaczniemy w 30 minut”', async (_name, proof) => {
    ctx.get.mockResolvedValue({ supabase: client({ ...CONFIRMED_TENANT, ...proof }), tenantId: 'org-1', role: 'owner' });
    ctx.read.mockResolvedValue({
      ok: true,
      status: syncStatus({
        outgoing: stream('outgoing', { phase: 'waiting', coveredFrom: null }),
        incoming: stream('incoming', { phase: 'waiting', coveredFrom: null }),
      }),
    });
    const t = text(renderToStaticMarkup(await ImportDanychPage({})));
    expect(t).toContain('Certyfikat KSeF wymaga ponownego potwierdzenia.');
    expect(t).not.toContain('Zaczniemy w ciągu 30 minut');
    expect(t).not.toContain('Automatycznie');
  });

  it.each([
    ['odczyt zwraca ok:false', () => ctx.read.mockResolvedValue({ ok: false })],
    ['odczyt rzuca wyjątek', () => ctx.read.mockRejectedValue(new Error('boom'))],
  ])('%s: karta mówi o błędzie, import z pliku dalej działa', async (_name, arrange) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      ctx.get.mockResolvedValue({
        supabase: client(CONFIRMED_TENANT),
        tenantId: 'org-1',
        role: 'owner',
      });
      arrange();
      const html = renderToStaticMarkup(await ImportDanychPage({}));
      expect(text(html)).toContain('Nie udało się wczytać stanu pobierania z KSeF.');
      expect(html.match(/>Wgraj plik</g)).toHaveLength(4);
    } finally {
      error.mockRestore();
    }
  });
});

describe('stary adres Magicznego importu', () => {
  it('next.config: /onboarding/magic-import → /import-danych (na stałe)', () => {
    const src = readFileSync(join(process.cwd(), 'next.config.ts'), 'utf8');
    expect(src).toMatch(
      /source: '\/onboarding\/magic-import',\s*destination: '\/import-danych',\s*permanent: true,/,
    );
  });
});
