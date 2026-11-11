import { describe, expect, it, vi } from 'vitest';

import {
  MOI_KLIENCI_RPC,
  czytajMoichKlientow,
  najblizszyTermin,
  opisTerminu,
  pokazMoichKlientow,
  statusKsef,
} from '@/lib/dashboard/moi-klienci';

/**
 * Krok 6.2 planu kompletnej aplikacji, część 2: „Moi klienci”. Podsumowanie
 * firm z jednej funkcji bazy (00185) i to, co aplikacja z niego liczy:
 * kwoty w groszach, status KSeF, najbliższy termin z kalendarza modułu
 * tylko dla firmy z włączonym modułem, link w menu tylko dla księgowej
 * w co najmniej dwóch firmach.
 */

type Wiersz = Record<string, unknown>;

function wiersz(z: Wiersz = {}): Wiersz {
  return {
    organization_id: '00185185-0000-4000-8000-00000000000a',
    name: 'Alfa sp. z o.o.',
    nip: '1234567890',
    role: 'accountant',
    expenses_to_review: 0,
    overdue_count: 0,
    overdue_grosze: 0,
    overdue_foreign_count: 0,
    unknown_environment_count: 0,
    has_ksef_credentials: false,
    ksef_verified_at: null,
    ksef_verified_environment: null,
    ksef_certificate_expiry: null,
    vat_exemption_basis: null,
    ksiegowosc_enabled: false,
    ...z,
  };
}

function klient(data: unknown, error: { message: string } | null = null) {
  const rpc = vi.fn(async () => ({ data, error }));
  return { client: { rpc }, rpc };
}

const TERAZ = new Date('2026-11-10T09:00:00Z');

describe('najblizszyTermin: kalendarz modułu od dziś', () => {
  it('10.11.2026: 20.11 to ZUS i podatek dochodowy (oba rodzaje podatku, forma nieznana)', () => {
    expect(najblizszyTermin('2026-11-10', { vat: false })).toEqual({
      data: '2026-11-20',
      rodzaje: ['zus', 'ryczalt', 'zaliczkaPit'],
    });
  });

  it('dzień terminu jest jeszcze terminem', () => {
    expect(najblizszyTermin('2026-11-20', { vat: true })?.data).toBe('2026-11-20');
  });

  it('po 20.: płatnik VAT ma 25., reszta następny miesiąc po przesunięciu z niedzieli', () => {
    expect(najblizszyTermin('2026-11-21', { vat: true })).toEqual({ data: '2026-11-25', rodzaje: ['vatJpk'] });
    // 20.12.2026 to niedziela, więc termin to poniedziałek 21.12.
    expect(najblizszyTermin('2026-11-21', { vat: false })).toEqual({
      data: '2026-12-21',
      rodzaje: ['zus', 'ryczalt', 'zaliczkaPit'],
    });
  });

  it('po 25.: termin za bieżący miesiąc w następnym', () => {
    expect(najblizszyTermin('2026-11-26', { vat: true })?.data).toBe('2026-12-21');
  });

  it('opis rodzajów bez powtórzeń', () => {
    expect(opisTerminu(['zus', 'ryczalt', 'zaliczkaPit'])).toBe('ZUS i podatek dochodowy');
    expect(opisTerminu(['vatJpk'])).toBe('VAT i JPK_V7M');
    expect(opisTerminu(['zus', 'zaliczkaPit', 'vatJpk'])).toBe('ZUS, podatek dochodowy, VAT i JPK_V7M');
  });
});

describe('statusKsef: te same warunki co Ustawienia, KSeF', () => {
  const baza = { has_ksef_credentials: true, ksef_verified_at: '2026-10-01T00:00:00Z', ksef_verified_environment: 'test', ksef_certificate_expiry: null };

  it('połączono, gdy jest certyfikat i dowód w środowisku aplikacji', () => {
    expect(statusKsef(baza, TERAZ)).toBe('polaczono');
    expect(statusKsef({ ...baza, ksef_certificate_expiry: '2027-10-01T00:00:00Z' }, TERAZ)).toBe('polaczono');
  });

  it('wygasły certyfikat', () => {
    expect(statusKsef({ ...baza, ksef_certificate_expiry: '2026-11-09T00:00:00Z' }, TERAZ)).toBe('certyfikat_wygasl');
  });

  it('certyfikat bez dowodu albo z dowodem z innego środowiska wymaga potwierdzenia', () => {
    expect(statusKsef({ ...baza, ksef_verified_at: null }, TERAZ)).toBe('wymaga_potwierdzenia');
    expect(statusKsef({ ...baza, ksef_verified_environment: 'production' }, TERAZ)).toBe('wymaga_potwierdzenia');
  });

  it('bez certyfikatu', () => {
    expect(statusKsef({ ...baza, has_ksef_credentials: false }, TERAZ)).toBe('brak');
  });
});

describe('czytajMoichKlientow', () => {
  it('woła jedną funkcję bazy ze środowiskiem aplikacji i liczy z jej wierszy', async () => {
    const { client, rpc } = klient([
      wiersz({
        organization_id: 'b',
        name: 'Beta',
        nip: '9480000021',
        role: 'owner',
        expenses_to_review: 3,
        overdue_count: 2,
        overdue_grosze: 273000,
        overdue_foreign_count: 1,
        has_ksef_credentials: true,
        ksef_verified_at: '2026-10-01T00:00:00Z',
        ksef_verified_environment: 'test',
      }),
      wiersz({ organization_id: 'a', name: 'Alfa' }),
    ]);
    const czytajGlobalnyStop = vi.fn(async () => false);
    const wynik = await czytajMoichKlientow(client, { aktywnaFirma: 'b', teraz: TERAZ, czytajGlobalnyStop });

    expect(rpc).toHaveBeenCalledWith(MOI_KLIENCI_RPC, { p_ksef_environment: 'test' });
    expect(wynik.ok).toBe(true);
    if (!wynik.ok) return;
    // Alfabetycznie, nie w kolejności z bazy.
    expect(wynik.firmy.map((f) => f.nazwa)).toEqual(['Alfa', 'Beta']);
    const beta = wynik.firmy[1]!;
    expect(beta).toMatchObject({
      organizationId: 'b',
      nip: '9480000021',
      rola: 'owner',
      aktywna: true,
      kosztyDoOpisania: 3,
      poTerminie: { stan: 'ok', liczba: 2, sumaGr: 273000, walutaObca: 1 },
      ksef: 'polaczono',
      termin: null,
    });
    expect(wynik.firmy[0]).toMatchObject({ aktywna: false, kosztyDoOpisania: 0, ksef: 'brak', termin: null });
    // Żadna firma nie ma modułu: globalnego stopu nie trzeba czytać.
    expect(czytajGlobalnyStop).not.toHaveBeenCalled();
  });

  it('termin tylko dla firmy z włączonym modułem; VAT tylko płatnikowi VAT', async () => {
    const { client } = klient([
      wiersz({ organization_id: 'a', name: 'Alfa', ksiegowosc_enabled: true }),
      wiersz({ organization_id: 'b', name: 'Beta', ksiegowosc_enabled: true, vat_exemption_basis: 'art. 113 ust. 1' }),
      wiersz({ organization_id: 'c', name: 'Gamma', ksiegowosc_enabled: false }),
    ]);
    const czytajGlobalnyStop = vi.fn(async () => false);
    const wynik = await czytajMoichKlientow(client, {
      aktywnaFirma: null,
      teraz: new Date('2026-11-21T09:00:00Z'),
      czytajGlobalnyStop,
    });
    expect(wynik.ok).toBe(true);
    if (!wynik.ok) return;
    const [alfa, beta, gamma] = wynik.firmy;
    expect(alfa!.termin).toEqual({ stan: 'ok', data: '2026-11-25', rodzaje: ['vatJpk'] });
    expect(beta!.termin).toEqual({ stan: 'ok', data: '2026-12-21', rodzaje: ['zus', 'ryczalt', 'zaliczkaPit'] });
    expect(gamma!.termin).toBeNull();
    expect(czytajGlobalnyStop).toHaveBeenCalledTimes(1);
  });

  it('globalny stop modułu chowa terminy wszystkim', async () => {
    const { client } = klient([wiersz({ ksiegowosc_enabled: true })]);
    const wynik = await czytajMoichKlientow(client, { aktywnaFirma: null, teraz: TERAZ, czytajGlobalnyStop: async () => true });
    expect(wynik.ok && wynik.firmy[0]!.termin).toBeNull();
  });

  it('nieudany odczyt globalnego stopu: firma z modułem dostaje komunikat, bez daty', async () => {
    const { client } = klient([
      wiersz({ organization_id: 'a', name: 'Alfa', ksiegowosc_enabled: true }),
      wiersz({ organization_id: 'b', name: 'Beta', ksiegowosc_enabled: false }),
    ]);
    const wynik = await czytajMoichKlientow(client, {
      aktywnaFirma: null,
      teraz: TERAZ,
      czytajGlobalnyStop: async () => {
        throw new Error('baza niedostępna');
      },
    });
    expect(wynik.ok).toBe(true);
    if (!wynik.ok) return;
    expect(wynik.firmy[0]!.termin).toEqual({ stan: 'nieznany' });
    expect(wynik.firmy[1]!.termin).toBeNull();
  });

  it('przyjęte faktury bez znanego środowiska: bez liczby i sumy (jak getReceivables)', async () => {
    const { client } = klient([wiersz({ overdue_count: 4, overdue_grosze: 100, unknown_environment_count: 1 })]);
    const wynik = await czytajMoichKlientow(client, { aktywnaFirma: null, teraz: TERAZ });
    expect(wynik.ok && wynik.firmy[0]!.poTerminie).toEqual({ stan: 'srodowisko' });
  });

  it('pusta lista z bazy to pusta lista, nie błąd', async () => {
    const { client } = klient([]);
    expect(await czytajMoichKlientow(client, { aktywnaFirma: null, teraz: TERAZ })).toEqual({ ok: true, firmy: [] });
  });

  it('błąd funkcji bazy albo zły wiersz: odmowa zamiast zer', async () => {
    const blad = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await czytajMoichKlientow(klient(null, { message: 'permission denied' }).client, { aktywnaFirma: null, teraz: TERAZ })).toEqual({ ok: false });
      expect(await czytajMoichKlientow(klient([wiersz({ overdue_grosze: '12.5' })]).client, { aktywnaFirma: null, teraz: TERAZ })).toEqual({ ok: false });
      expect(await czytajMoichKlientow(klient([wiersz({ role: 'viewer' })]).client, { aktywnaFirma: null, teraz: TERAZ })).toEqual({ ok: false });
      expect(await czytajMoichKlientow(klient({ nie: 'tablica' }).client, { aktywnaFirma: null, teraz: TERAZ })).toEqual({ ok: false });
    } finally {
      blad.mockRestore();
    }
  });
});

describe('pokazMoichKlientow: link w menu', () => {
  it('księgowa w co najmniej dwóch firmach', () => {
    expect(pokazMoichKlientow([{ role: 'accountant' }, { role: 'accountant' }])).toBe(true);
    expect(pokazMoichKlientow([{ role: 'accountant' }, { role: 'owner' }, { role: 'accountant' }])).toBe(true);
  });

  it('jedna firma z rolą księgowej albo same inne role: bez linku', () => {
    expect(pokazMoichKlientow([{ role: 'accountant' }, { role: 'owner' }])).toBe(false);
    expect(pokazMoichKlientow([{ role: 'owner' }, { role: 'admin' }, { role: 'member' }])).toBe(false);
    expect(pokazMoichKlientow([])).toBe(false);
  });
});
