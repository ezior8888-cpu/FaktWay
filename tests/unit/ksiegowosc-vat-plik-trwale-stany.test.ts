import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F11-A4: plik JPK_V7M. Błąd odczytu NIP-u albo urzędu to błąd odczytu, nie
 * „popraw NIP”; niezgodność z XSD idzie do Sentry. Atrapy tylko dla bazy,
 * odczytu VAT, urzędu, walidatora i Sentry; generator pliku jest prawdziwy.
 */

const mocks = vi.hoisted(() => ({
  firma: { data: { nip: '1234567890', name: 'Jan Testowy' }, error: null } as { data: unknown; error: unknown },
  urzad: 'ok' as 'ok' | 'brak' | 'blad',
  xsd: { valid: true, errors: [] as string[] },
  dane: null as unknown,
  sentryKomunikat: vi.fn(),
  sentryWyjatek: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: mocks.sentryWyjatek, captureMessage: mocks.sentryKomunikat }));
vi.mock('@/lib/format/warsaw-date', async (orig) => ({
  ...(await orig<typeof import('@/lib/format/warsaw-date')>()),
  todayInWarsaw: () => '2026-11-07',
}));
vi.mock('@/lib/supabase/auth-context', async (orig) => ({
  ...(await orig<typeof import('@/lib/supabase/auth-context')>()),
  requireOrgRole: async () => ({ supabase, user: { id: 'u-1', email: 'jan@example.test' }, tenantId: 'firma-1', role: 'owner' }),
}));
vi.mock('@/lib/ksiegowosc/wylacznik', () => ({ czyKsiegowoscWlaczona: async () => ({ wlaczony: true }) }));
vi.mock('@/lib/ksiegowosc/vat-dane', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/vat-dane')>()),
  czytajVat: async () => mocks.dane,
}));
vi.mock('@/lib/exports/tax-office', async (orig) => ({
  ...(await orig<typeof import('@/lib/exports/tax-office')>()),
  readTenantTaxOffice: async () => {
    if (mocks.urzad === 'blad') throw new Error('Nie można odczytać urzędu skarbowego firmy: timeout');
    return mocks.urzad === 'brak' ? null : '1433';
  },
}));
vi.mock('@/lib/exports/jpk-v7m-validator', () => ({ validateJpkV7m: async () => mocks.xsd }));

const supabase = {
  from: () => {
    const l: Record<string, unknown> = {};
    l.select = () => l;
    l.eq = () => l;
    l.maybeSingle = async () => mocks.firma;
    return l;
  },
};

const { pobierzJpkV7mAction } = await import('@/app/actions/ksiegowosc-vat');
const { vatMiesiaca } = await import('@/lib/ksiegowosc/vat');
const { BLAD_ODCZYTU_VAT } = await import('@/lib/ksiegowosc/vat-dane');

const WEJSCIE = { miesiac: '2026-10', nadwyzka: 0, imie: 'Jan', nazwisko: 'Testowy', dataUrodzenia: '1980-01-01', email: 'jan@example.test' };

beforeEach(() => {
  mocks.firma = { data: { nip: '1234567890', name: 'Jan Testowy' }, error: null };
  mocks.urzad = 'ok';
  mocks.xsd = { valid: true, errors: [] };
  mocks.sentryKomunikat.mockReset();
  mocks.sentryWyjatek.mockReset();
  mocks.dane = {
    ok: true,
    miesiac: '2026-10',
    dane: { issuer: { nip: '1234567890', name: 'Jan Testowy' }, issuedInvoices: [], receivedInvoices: [], expenses: [] },
    nadwyzka: { zl: 0, zrodlo: 'klient' },
    wynik: vatMiesiaca({ sprzedaz: [], koszty: [] }, 0),
    wysylki: [],
  };
});

describe('F11-A4: plik JPK_V7M', () => {
  it('błąd odczytu danych firmy to błąd odczytu, nie prośba o poprawę NIP', async () => {
    mocks.firma = { data: null, error: { message: 'timeout' } };
    expect(await pobierzJpkV7mAction(WEJSCIE)).toEqual({ success: false, error: BLAD_ODCZYTU_VAT });
  });

  it('błąd odczytu urzędu to błąd odczytu, brak urzędu zostaje komunikatem o Ustawieniach', async () => {
    mocks.urzad = 'blad';
    expect(await pobierzJpkV7mAction(WEJSCIE)).toEqual({ success: false, error: BLAD_ODCZYTU_VAT });
    mocks.urzad = 'brak';
    expect(await pobierzJpkV7mAction(WEJSCIE)).toMatchObject({ success: false, error: expect.stringContaining('urzędu skarbowego') });
  });

  it('niezgodność z XSD: komunikat dla klienta i alarm w Sentry bez NIP-u w treści', async () => {
    mocks.xsd = { valid: false, errors: ['Element P_38: wartość niedozwolona'] };
    expect(await pobierzJpkV7mAction(WEJSCIE)).toMatchObject({ success: false, error: expect.stringContaining('kontroli schematu') });
    expect(mocks.sentryKomunikat).toHaveBeenCalledTimes(1);
    const [tresc, opcje] = mocks.sentryKomunikat.mock.calls[0];
    expect(tresc).not.toContain('1234567890');
    expect(opcje).toMatchObject({
      level: 'error',
      tags: { area: 'ksiegowosc.vat' },
      fingerprint: ['jpk_v7m_xsd', '2026-10'],
      extra: expect.objectContaining({ tenantId: 'firma-1', miesiac: '2026-10' }),
    });
    expect(JSON.stringify(opcje)).not.toContain('1234567890');
  });
});
