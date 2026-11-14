import fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { KODY_PRZYPOMNIEN, sprawdzPrzypomnienie } from '@/lib/bezpieczniki/przypomnienia';
import type { WersjaProfilu } from '@/lib/ksiegowosc/profil';
import type { TerminNaDzis } from '@/lib/ksiegowosc/przypomnienia';
import type { PozycjaZeSkrotem, Rozliczenie } from '@/lib/ksiegowosc/ten-miesiac-dane';

/**
 * Strażnik przypomnień o terminach (żelazny filtr F13 część 5,
 * `lib/bezpieczniki/przypomnienia.ts`) i jego wpięcie w
 * `cron.ksiegowosc-terminy`: kwota z zatwierdzonej wersji, która nie przejdzie
 * kontroli, nie trafia do klienta (przypomnienie bez kwoty), a termin poza dniem
 * roboczym zatrzymuje przypomnienie; w obu przypadkach alarm FILTR-RT-PRZ.
 */

const m = vi.hoisted(() => ({
  rozliczenia: [] as unknown[],
  pozycjeSzkicu: [] as unknown[],
  maile: [] as Array<{ tresc: string }>,
  pushe: [] as Array<{ body: string }>,
  zajete: 0,
  captureMessage: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({ captureMessage: m.captureMessage, captureException: vi.fn() }));
vi.mock('@/lib/ksiegowosc/wylacznik', () => ({
  czyKsiegowoscWlaczona: vi.fn(async () => ({ wlaczony: true })),
  statusObszaru: vi.fn(() => ({ wlaczony: true })),
}));
vi.mock('@/lib/ksiegowosc/profil', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/profil')>()),
  czytajWersjeProfilu: vi.fn(async () => [PROFIL]),
}));
vi.mock('@/lib/ksiegowosc/ten-miesiac-dane', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/ten-miesiac-dane')>()),
  czytajTenMiesiac: vi.fn(async () => ({ ok: true, pozycje: m.pozycjeSzkicu, rozliczenia: m.rozliczenia, braki: [] })),
}));
vi.mock('@/lib/ksiegowosc/powiadomienia', () => ({
  firmyWPilotazu: vi.fn(async () => []),
  wlasciciel: vi.fn(async () => ({ email: 'wlasciciel@example.test', userId: 'u-1' })),
  zajmij: vi.fn(async () => { m.zajete++; return 'nowe'; }),
  zamknij: vi.fn(async () => undefined),
}));
vi.mock('@/lib/invoices/vat-exemption', async (orig) => ({
  ...(await orig<typeof import('@/lib/invoices/vat-exemption')>()),
  readTenantVatExemption: vi.fn(async () => null),
}));
vi.mock('@/lib/email/send', () => ({
  sendTerminRozliczeniaEmail: vi.fn(async (_do: string, d: { tresc: string }) => { m.maile.push({ tresc: d.tresc }); return { sent: true }; }),
}));
vi.mock('@/lib/push/sender', () => ({
  sendPushToTenant: vi.fn(async (_t: string, _k: string, d: { body: string }) => { m.pushe.push({ body: d.body }); return { sent: 1 }; }),
}));
vi.mock('@/lib/app-notifications/publish', () => ({ publishAppNotification: vi.fn(async () => undefined) }));

import { przypomnijOTerminie } from '@/lib/jobs/runners/ksiegowosc-terminy';

const PROFIL: WersjaProfilu = {
  id: 'p1', validFrom: '2026-01-01', forma: 'ryczalt', stawkaDomyslna: 1200, zusEtap: 'pelny',
  zusOd: null, chorobowe: true, nrsZus: null, najem: false,
};

const wersja = (rodzaj: Rozliczenie['rodzaj'], kwotaGr: number): Rozliczenie => ({
  id: `${rodzaj}-1`, miesiac: '2026-10', rodzaj, wersja: 1, kwotaGr, termin: '2026-11-20', status: 'zatwierdzone',
  wejsciaHash: 'a'.repeat(64), zatwierdzoneO: '2026-11-02T10:00:00Z', zaplaconeO: null, spoleczneBezFpGr: 0, reczna: false,
});
const szkic = (rodzaj: PozycjaZeSkrotem['rodzaj'], kwotaGr: number): PozycjaZeSkrotem => ({
  ok: true, rodzaj, kwotaGr, termin: null, wejscia: {}, wejsciaHash: 'a'.repeat(64),
});

const termin = (faktyczny: string): TerminNaDzis =>
  ({ miesiac: '2026-10', termin: { rodzaj: 'ryczalt', nominalny: faktyczny, faktyczny, przesuniety: false }, dni: 5, etap: `termin-5:${faktyczny}`, grupy: ['ryczalt'] }) as unknown as TerminNaDzis;

beforeEach(() => {
  vi.clearAllMocks();
  m.rozliczenia = [];
  m.pozycjeSzkicu = [];
  m.maile = [];
  m.pushe = [];
  m.zajete = 0;
});

describe('strażnik przypomnień: funkcja', () => {
  it('kwoty w porządku i dzień roboczy: bez zmian, bez alarmu', () => {
    const pozycje = [{ rodzaj: 'ryczalt' as const, kwotaGr: 153_600 }, { rodzaj: 'zdrowotna' as const, kwotaGr: 49_835 }, { rodzaj: 'pit' as const, kwotaGr: null }];
    expect(sprawdzPrzypomnienie({ miesiac: '2026-10', termin: '2026-11-20', pozycje })).toEqual({ pozycje, wyslac: true, alarmy: [] });
  });

  it.each([
    ['ryczałt z groszami', 'ryczalt', 153_650],
    ['VAT z groszami', 'vat', 10_001],
    ['kwota ujemna', 'zdrowotna', -1],
    ['ułamek grosza', 'zus_spoleczne', 1_926.5],
    ['poza bezpiecznym zakresem', 'pit', 2 ** 60],
  ] as const)('%s: pozycja bez kwoty, alarm FILTR-RT-PRZ-01, przypomnienie wychodzi', (_opis, rodzaj, kwotaGr) => {
    const k = sprawdzPrzypomnienie({ miesiac: '2026-10', termin: '2026-11-20', pozycje: [{ rodzaj, kwotaGr }] });
    expect(k.pozycje).toEqual([{ rodzaj, kwotaGr: null }]);
    expect(k.wyslac).toBe(true);
    expect(k.alarmy.map((a) => a.kod)).toEqual([KODY_PRZYPOMNIEN.kwota]);
  });

  it.each(['2026-11-21', '2026-11-22', '2026-11-11', '2026-12-24', '2026-02-30', 'jutro'])('termin %s poza dniem roboczym albo zły: bez wysyłki, alarm FILTR-RT-PRZ-02', (dzien) => {
    const k = sprawdzPrzypomnienie({ miesiac: '2026-10', termin: dzien, pozycje: [{ rodzaj: 'ryczalt', kwotaGr: 100 }] });
    expect(k.wyslac).toBe(false);
    expect(k.alarmy.map((a) => a.kod)).toEqual([KODY_PRZYPOMNIEN.termin]);
  });

  it('losowe poprawne kwoty w dniu roboczym nic nie zmieniają', () => {
    const pozycja = fc.oneof(
      fc.record({ rodzaj: fc.constantFrom('ryczalt' as const, 'pit' as const, 'vat' as const), kwotaGr: fc.integer({ min: 0, max: 10_000_000 }).map((z) => z * 100) }),
      fc.record({ rodzaj: fc.constantFrom('zus_spoleczne' as const, 'zdrowotna' as const), kwotaGr: fc.integer({ min: 0, max: 1_000_000_000 }) }),
    );
    fc.assert(fc.property(fc.array(pozycja, { maxLength: 5 }), (pozycje) => {
      expect(sprawdzPrzypomnienie({ miesiac: '2026-10', termin: '2026-11-20', pozycje })).toEqual({ pozycje, wyslac: true, alarmy: [] });
    }));
  });
});

describe('strażnik przypomnień w cron.ksiegowosc-terminy', () => {
  const admin = {} as never;

  it('zatwierdzona wersja z groszami w ryczałcie: przypomnienie bez kwoty i alarm z firmą', async () => {
    m.rozliczenia = [wersja('ryczalt', 153_650)];
    m.pozycjeSzkicu = [szkic('ryczalt', 153_700)];
    await expect(przypomnijOTerminie(admin, 'ten-1', termin('2026-11-20'))).resolves.toBe('wyslane');
    expect(m.maile).toHaveLength(1);
    expect(m.maile[0]!.tresc).not.toMatch(/1\s?536,50/);
    expect(m.pushe[0]!.body).not.toMatch(/1\s?536,50/);
    expect(m.captureMessage).toHaveBeenCalledTimes(1);
    expect(m.captureMessage.mock.calls[0]![1]).toMatchObject({ tags: { kod: KODY_PRZYPOMNIEN.kwota, straznik: 'przypomnienia', tenantId: 'ten-1' } });
  });

  it('termin w sobotę: bez przypomnienia i bez wpisu „sent”, alarm', async () => {
    m.rozliczenia = [wersja('ryczalt', 153_600)];
    await expect(przypomnijOTerminie(admin, 'ten-1', termin('2026-11-21'))).resolves.toBe('pominiete');
    expect(m.zajete).toBe(0);
    expect(m.maile).toEqual([]);
    expect(m.pushe).toEqual([]);
    expect(m.captureMessage.mock.calls[0]![1]).toMatchObject({ tags: { kod: KODY_PRZYPOMNIEN.termin } });
  });

  it('poprawna kwota w dniu roboczym: przypomnienie z kwotą, bez alarmu', async () => {
    m.rozliczenia = [wersja('ryczalt', 153_600)];
    await expect(przypomnijOTerminie(admin, 'ten-1', termin('2026-11-20'))).resolves.toBe('wyslane');
    expect(m.maile[0]!.tresc).toMatch(/1\s?536,00/);
    expect(m.captureMessage).not.toHaveBeenCalled();
  });
});
