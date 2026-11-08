import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { czyRachunekNrb, mikrorachunekZNip } from '@/lib/ksiegowosc/mikrorachunek';
import {
  czytajWersjeProfilu,
  domyslnyPoczatek,
  komunikatBrakuProfilu,
  profilSchema,
  sprawdzZmianeFormy,
  STAWKI_RYCZALTU,
  stawkaRyczaltuPozycji,
  wersjaNa,
  type Profil,
  type WersjaProfilu,
} from '@/lib/ksiegowosc/profil';

/**
 * Profil podatkowy (plan księgowości JDG, K2): schemat wspólny dla kreatora
 * i akcji, wersje po `valid_from`, forma tylko od 1 stycznia (ta sama reguła
 * co wyzwalacz 00166), stawka ryczałtu pozycji z profilu.
 */

const RYCZALT: Profil = {
  validFrom: '2027-01-01',
  forma: 'ryczalt',
  stawkaDomyslna: 1200,
  zusEtap: 'pelny',
  zusOd: null,
  chorobowe: true,
  nrsZus: null,
  najem: false,
};

function wersja(nadpisz: Partial<WersjaProfilu>): WersjaProfilu {
  return { id: `w-${nadpisz.validFrom ?? 'x'}`, ...RYCZALT, ...nadpisz };
}

describe('schemat profilu', () => {
  it('przyjmuje pełny profil ryczałtu', () => {
    expect(profilSchema.safeParse(RYCZALT).success).toBe(true);
  });

  it('ryczałt wymaga stawki z listy, inne formy nie mają stawki', () => {
    const bez = profilSchema.safeParse({ ...RYCZALT, stawkaDomyslna: null });
    expect(bez.success).toBe(false);
    expect(bez.error?.issues[0]?.path).toEqual(['stawkaDomyslna']);
    expect(profilSchema.safeParse({ ...RYCZALT, stawkaDomyslna: 1250 }).success).toBe(false);
    expect(profilSchema.safeParse({ ...RYCZALT, forma: 'skala' }).success).toBe(false);
    expect(profilSchema.safeParse({ ...RYCZALT, forma: 'liniowy', stawkaDomyslna: null }).success).toBe(true);
  });

  it('ulga na start i preferencyjne wymagają daty, pełne i etat obok nie', () => {
    expect(profilSchema.safeParse({ ...RYCZALT, zusEtap: 'ulga_na_start' }).success).toBe(false);
    expect(profilSchema.safeParse({ ...RYCZALT, zusEtap: 'preferencyjny', zusOd: '2026-07-01' }).success).toBe(true);
    expect(profilSchema.safeParse({ ...RYCZALT, zusEtap: 'etat_obok' }).success).toBe(true);
  });

  it('data od 2026 r. i prawdziwa data kalendarzowa', () => {
    expect(profilSchema.safeParse({ ...RYCZALT, validFrom: '2025-12-31' }).success).toBe(false);
    expect(profilSchema.safeParse({ ...RYCZALT, validFrom: '2027-02-30' }).success).toBe(false);
  });

  it('rachunek ZUS: spacje znikają, numer musi mieć poprawną sumę kontrolną', () => {
    const numer = mikrorachunekZNip('1234563218')!;
    const zSpacjami = numer.replace(/(\d{2})(\d{4})/, '$1 $2 ');
    const ok = profilSchema.safeParse({ ...RYCZALT, nrsZus: zSpacjami });
    expect(ok.success && ok.data.nrsZus).toBe(numer);
    const zmieniony = `${numer.slice(0, 25)}${(Number(numer[25]) + 1) % 10}`;
    expect(czyRachunekNrb(zmieniony)).toBe(false);
    expect(profilSchema.safeParse({ ...RYCZALT, nrsZus: zmieniony }).success).toBe(false);
    expect(profilSchema.safeParse({ ...RYCZALT, nrsZus: '123' }).success).toBe(false);
    const puste = profilSchema.safeParse({ ...RYCZALT, nrsZus: '  ' });
    expect(puste.success && puste.data.nrsZus).toBeNull();
  });

  it('stawki do wyboru: osiem grup z opisem, bez 12,5 %', () => {
    expect(STAWKI_RYCZALTU.map((s) => s.pb)).toEqual([1700, 1500, 1400, 1200, 1000, 850, 550, 300]);
    for (const s of STAWKI_RYCZALTU) {
      expect(s.opis.length).toBeGreaterThan(10);
      expect(s.opis).not.toMatch(/[—–]/);
    }
  });
});

describe('wersje po dacie', () => {
  const wersje = [wersja({ validFrom: '2026-03-01' }), wersja({ validFrom: '2027-01-01', forma: 'liniowy', stawkaDomyslna: null })];

  it('wersja obowiązująca w dniu', () => {
    expect(wersjaNa(wersje, '2026-02-28')).toBeNull();
    expect(wersjaNa(wersje, '2026-12-31')?.validFrom).toBe('2026-03-01');
    expect(wersjaNa(wersje, '2027-01-01')?.forma).toBe('liniowy');
  });

  it('domyślny początek: 1 stycznia albo start działalności w tym roku', () => {
    expect(domyslnyPoczatek('2027-06-10', null)).toBe('2027-01-01');
    expect(domyslnyPoczatek('2027-06-10', '2019-05-01')).toBe('2027-01-01');
    expect(domyslnyPoczatek('2027-06-10', '2027-03-15')).toBe('2027-03-15');
  });
});

describe('forma tylko od 1 stycznia (jak wyzwalacz 00166)', () => {
  const wersje = [wersja({ validFrom: '2026-03-15' })];

  it('pierwsza wersja może zacząć się dowolnego dnia', () => {
    expect(sprawdzZmianeFormy([], { ...RYCZALT, validFrom: '2026-03-15' })).toBeNull();
  });

  it('zmiana formy w trakcie roku odrzucona, od 1 stycznia przyjęta', () => {
    const liniowy = { ...RYCZALT, forma: 'liniowy' as const, stawkaDomyslna: null };
    expect(sprawdzZmianeFormy(wersje, { ...liniowy, validFrom: '2026-07-01' })).toContain('1 stycznia');
    expect(sprawdzZmianeFormy(wersje, { ...liniowy, validFrom: '2027-01-01' })).toBeNull();
  });

  // Blokada z wyjściem (protokół, pkt 4): od kiedy zmiana jest możliwa albo którą wersję poprawić.
  it('odmowa mówi, od kiedy nowa forma może obowiązywać i którą wersję poprawić', () => {
    const tekst = sprawdzZmianeFormy(wersje, { ...RYCZALT, forma: 'skala', stawkaDomyslna: null, validFrom: '2026-07-01' });
    expect(tekst).toBe(
      'Forma opodatkowania zmienia się tylko od 1 stycznia, więc skala podatkowa może obowiązywać od 01.01.2027. ' +
        'Jeśli forma od początku była inna, wystarczy poprawić wersję od 15.03.2026.',
    );
  });

  it('ta sama forma od dowolnego miesiąca (np. zmiana składek ZUS)', () => {
    expect(sprawdzZmianeFormy(wersje, { ...RYCZALT, validFrom: '2026-09-01', zusEtap: 'pelny' })).toBeNull();
  });

  it('wstawka przed późniejszą wersją z inną formą też podlega regule', () => {
    const pozniejsza = [wersja({ validFrom: '2027-06-01', forma: 'skala', stawkaDomyslna: null })];
    expect(sprawdzZmianeFormy(pozniejsza, { ...RYCZALT, validFrom: '2027-01-01' })).toBe(
      'Forma opodatkowania zmienia się tylko od 1 stycznia, a od 01.06.2027 obowiązuje skala podatkowa. ' +
        'Wcześniejsza wersja może mieć tę samą formę albo wersję od 01.06.2027 można poprawić.',
    );
  });

  it('poprawka tej samej wersji nie porównuje się sama ze sobą', () => {
    expect(sprawdzZmianeFormy(wersje, { ...RYCZALT, validFrom: '2026-03-15', forma: 'skala', stawkaDomyslna: null })).toBeNull();
  });
});

describe('stawka ryczałtu pozycji faktury', () => {
  const ryczalt = wersja({ validFrom: '2027-01-01' });

  it('stawka z pozycji wygrywa, bez niej domyślna z profilu', () => {
    expect(stawkaRyczaltuPozycji('8.50', ryczalt)).toBe(850);
    expect(stawkaRyczaltuPozycji(3, ryczalt)).toBe(300);
    expect(stawkaRyczaltuPozycji(null, ryczalt)).toBe(1200);
  });

  it('poza ryczałtem i bez profilu: brak stawki', () => {
    expect(stawkaRyczaltuPozycji('12.00', wersja({ forma: 'skala', stawkaDomyslna: null }))).toBeNull();
    expect(stawkaRyczaltuPozycji('12.00', null)).toBeNull();
  });
});

describe('fail-closed', () => {
  it('komunikat bez profilu: nazwa braku i gdzie są ustawienia, bez trybu rozkazującego', () => {
    const tekst = komunikatBrakuProfilu('2027-03-01');
    expect(tekst).toContain('01.03.2027');
    expect(tekst).toContain('Ustawienia podatkowe');
    expect(tekst).not.toMatch(/\b(uzupełnij|zapłać|sprawdź|dodaj)\b/i);
    expect(tekst).not.toMatch(/[—–]/);
  });

  function klient(odpowiedz: { data: unknown; error: { code?: string; message: string } | null }) {
    const order = vi.fn().mockResolvedValue(odpowiedz);
    const eq = vi.fn(() => ({ order }));
    const select = vi.fn(() => ({ eq }));
    return { from: vi.fn(() => ({ select })) } as unknown as SupabaseClient;
  }

  it('odczyt: wiersze na wersje, brak tabeli przed 00166 to pusta lista, inny błąd rzuca', async () => {
    const wiersz = {
      id: 'p1', valid_from: '2027-01-01', forma: 'ryczalt', stawka_domyslna: 850, zus_etap: 'pelny',
      zus_od: null, chorobowe: false, nrs_zus: null,
    };
    expect(await czytajWersjeProfilu(klient({ data: [wiersz], error: null }), 'f')).toEqual([
      { id: 'p1', validFrom: '2027-01-01', forma: 'ryczalt', stawkaDomyslna: 850, zusEtap: 'pelny', zusOd: null, chorobowe: false, najem: false, nrsZus: null },
    ]);
    expect(await czytajWersjeProfilu(klient({ data: null, error: { code: 'PGRST205', message: 'brak tabeli' } }), 'f')).toEqual([]);
    await expect(czytajWersjeProfilu(klient({ data: null, error: { code: '57014', message: 'timeout' } }), 'f')).rejects.toThrow(
      'ustawień podatkowych',
    );
  });
});
