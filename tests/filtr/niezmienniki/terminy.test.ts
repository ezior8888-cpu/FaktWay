import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { czyDzienRoboczy, dniWolne, najblizszyDzienRoboczy, terminDla, wielkanoc, type RodzajTerminu } from '@/lib/ksiegowosc/kalendarz';
import { czyMikrorachunekZNip, mikrorachunekZNip } from '@/lib/ksiegowosc/mikrorachunek';

import { nip } from '../generatory/ksiegowosc';
import { opcje } from '../generatory/ustawienia';

/**
 * Niezmienniki terminów, kalendarza i mikrorachunku (plan filtra B4.2,
 * NZ-TERM i NZ-MIKRO; rejestr RP-TERM-01, RP-TERM-02, RP-MIKRO-01).
 */
const rodzaj = fc.constantFrom('ryczalt', 'zaliczkaPit', 'zus', 'vatJpk') as fc.Arbitrary<RodzajTerminu>;
const okres = fc.record({ rodzaj, rok: fc.constantFrom(2026), miesiac: fc.integer({ min: 1, max: 12 }) });
const DOBA = 86_400_000;

describe('NZ-TERM-01: termin nigdy w dzień wolny; przesunięcie do przodu (art. 12 § 5 Ordynacji podatkowej)', () => {
  it('termin faktyczny to dzień roboczy, nie wcześniej niż nominalny, najwyżej 4 dni później', () => {
    fc.assert(
      fc.property(okres, (o) => {
        const t = terminDla(o);
        if (!t) throw new Error('oczekiwany termin');
        const faktyczny = new Date(`${t.faktyczny}T00:00:00Z`);
        expect(czyDzienRoboczy(faktyczny)).toBe(true);
        const dni = (faktyczny.getTime() - Date.parse(`${t.nominalny}T00:00:00Z`)) / DOBA;
        expect(dni).toBeGreaterThanOrEqual(0);
        expect(dni).toBeLessThanOrEqual(4);
        expect(t.przesuniety).toBe(dni > 0);
      }),
      opcje(),
    );
  });

  it('najbliższy dzień roboczy jest idempotentny i nigdy wcześniejszy', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 365 * 5 }), (d) => {
        const dzien = new Date(Date.UTC(2025, 0, 1) + d * DOBA);
        const roboczy = najblizszyDzienRoboczy(dzien);
        expect(roboczy.getTime()).toBeGreaterThanOrEqual(dzien.getTime());
        expect(najblizszyDzienRoboczy(roboczy).getTime()).toBe(roboczy.getTime());
        for (let t = dzien.getTime(); t < roboczy.getTime(); t += DOBA) expect(czyDzienRoboczy(new Date(t))).toBe(false);
      }),
      opcje(),
    );
  });
});

describe('NZ-TERM-02: termin ustawowy w miesiącu po okresie; grudzień daje styczeń', () => {
  it('20. dla ryczałtu, zaliczki i ZUS, 25. dla JPK_V7M i VAT', () => {
    fc.assert(
      fc.property(okres, (o) => {
        const t = terminDla(o)!;
        const [r, m, d] = t.nominalny.split('-').map(Number);
        expect(d).toBe(o.rodzaj === 'vatJpk' ? 25 : 20);
        expect(r * 12 + m).toBe(o.rok * 12 + o.miesiac + 1);
      }),
      opcje(),
    );
  });
});

describe('NZ-TERM-03: kalendarz świąt', () => {
  it('13 dni wolnych do 2024 r., 14 od 2025 r. (Wigilia); Wielkanoc w niedzielę, poniedziałek wielkanocny i Boże Ciało na swoich miejscach', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2000, max: 2100 }), (rok) => {
        const dni = dniWolne(rok);
        expect(dni.size).toBe(rok >= 2025 ? 14 : 13);
        const niedziela = wielkanoc(rok);
        expect(niedziela.getUTCDay()).toBe(0);
        const plus = (n: number) => new Date(niedziela.getTime() + n * DOBA).toISOString().slice(0, 10);
        expect(dni.has(plus(1))).toBe(true);
        expect(dni.has(plus(60))).toBe(true);
        expect(new Date(`${plus(60)}T00:00:00Z`).getUTCDay()).toBe(4);
        // Wielkanoc między 22 marca a 25 kwietnia.
        const md = (niedziela.getUTCMonth() + 1) * 100 + niedziela.getUTCDate();
        expect(md).toBeGreaterThanOrEqual(322);
        expect(md).toBeLessThanOrEqual(425);
      }),
      opcje(),
    );
  });
});

describe('NZ-MIKRO-01 i NZ-MIKRO-02: mikrorachunek z NIP', () => {
  it('poprawny NIP daje 26 cyfr, które przechodzą niezależny test mod 97 (IBAN z PL)', () => {
    fc.assert(
      fc.property(nip, (n) => {
        const numer = mikrorachunekZNip(n);
        expect(numer).not.toBeNull();
        const cyfry = (numer as string).replace(/\s/g, '');
        expect(cyfry).toMatch(/^\d{26}$/);
        expect(cyfry.slice(14, 24)).toBe(n);
        expect(czyMikrorachunekZNip(cyfry)).toBe(true);
        // PL = 25 21; IBAN: BBAN + kraj + cyfry kontrolne, mod 97 = 1.
        expect(BigInt(`${cyfry.slice(2)}2521${cyfry.slice(0, 2)}`) % BigInt(97)).toBe(BigInt(1));
      }),
      opcje(),
    );
  });

  it('NIP z błędną cyfrą kontrolną nie daje rachunku', () => {
    fc.assert(
      fc.property(nip, fc.integer({ min: 1, max: 9 }), (n, przesuniecie) => {
        const zly = `${n.slice(0, 9)}${(Number(n[9]) + przesuniecie) % 10}`;
        expect(mikrorachunekZNip(zly)).toBeNull();
      }),
      opcje(),
    );
  });
});
