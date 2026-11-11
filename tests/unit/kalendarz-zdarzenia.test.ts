import { describe, expect, it } from 'vitest';

import {
  zdarzeniaCykliczne,
  zdarzeniaNaleznosci,
  zdarzeniaTerminow,
} from '@/lib/kalendarz/zdarzenia';
import type { WersjaProfilu } from '@/lib/ksiegowosc/profil';

/**
 * Krok 7.3: z czego składa się kalendarz. Terminy podatków i ZUS pochodzą
 * z `terminDla` (kalendarz modułu księgowości, K1), więc przesunięcia przez
 * weekendy i święta są jego, nie nasze.
 */

const PROFIL_RYCZALT = { id: 'p1', validFrom: '2026-01-01', forma: 'ryczalt' } as unknown as WersjaProfilu;
const PROFIL_SKALA = { id: 'p2', validFrom: '2026-01-01', forma: 'skala' } as unknown as WersjaProfilu;

function terminy(wersje: WersjaProfilu[], platnikVat = true, dzis = '2026-11-10') {
  return zdarzeniaTerminow({ dzis, wersje, platnikVat });
}
const poDacie = <T extends { data: string }>(z: T[], data: string) => z.filter((e) => e.data === data);

describe('zdarzeniaTerminow', () => {
  it('ryczałt: ZUS i ryczałt w terminach z kalendarza, przesunięte przez weekend i święta', () => {
    const z = terminy([PROFIL_RYCZALT]);
    const listopad = poDacie(z, '2026-11-20').map((e) => e.tytul);
    expect(listopad).toHaveLength(2);
    expect(listopad.join('|')).toContain('Składki ZUS');
    expect(listopad.join('|')).toContain('ryczałt');
    // 20 grudnia 2026 to niedziela, termin przechodzi na poniedziałek 21.
    const grudzien = poDacie(z, '2026-12-21');
    expect(grudzien).toHaveLength(2);
    expect(grudzien[0]!.opis).toContain('20.12.2026');
    // 25 grudnia (święto), 26 (święto i sobota), 27 (niedziela): VAT dopiero 28.
    expect(poDacie(z, '2026-12-28').map((e) => e.tytul).join('|')).toContain('VAT');
  });

  it('skala dostaje zaliczkę PIT bez ryczałtu; ryczałt nie dostaje zaliczki PIT', () => {
    const skala = terminy([PROFIL_SKALA]).map((e) => e.tytul).join('|');
    expect(skala).toContain('zaliczka na PIT');
    expect(skala).not.toContain('ryczałt');
    const ryczalt = terminy([PROFIL_RYCZALT]).map((e) => e.tytul).join('|');
    expect(ryczalt).not.toContain('zaliczka na PIT');
  });

  it('bez płatnika VAT nie ma terminów VAT', () => {
    expect(terminy([PROFIL_RYCZALT], false).some((e) => e.tytul.includes('VAT'))).toBe(false);
  });

  it('pomija terminy sprzed dzisiaj i okresy sprzed pierwszej wersji profilu', () => {
    expect(terminy([PROFIL_RYCZALT]).every((e) => e.data >= '2026-11-10')).toBe(true);
    const odStyczniaPozniej = [{ ...PROFIL_RYCZALT, validFrom: '2027-01-01' } as WersjaProfilu];
    // Okresy do grudnia 2026 włącznie nie mają profilu, pierwszy termin to 20 lutego za styczeń.
    expect(terminy(odStyczniaPozniej).every((e) => e.data >= '2027-02-01')).toBe(true);
  });

  it('bez profilu nie zgadujemy: pusto (jak przypomnienia K5)', () => {
    expect(terminy([])).toEqual([]);
  });

  it('UID stabilny między wywołaniami i niepowtarzalny w kalendarzu', () => {
    const a = terminy([PROFIL_RYCZALT]).map((e) => e.uid);
    expect(a).toEqual(terminy([PROFIL_RYCZALT]).map((e) => e.uid));
    expect(new Set(a).size).toBe(a.length);
  });
});

describe('zdarzeniaNaleznosci', () => {
  it('niezapłacona faktura: numer, kwota i nazwa nabywcy, bez NIP-u', () => {
    const z = zdarzeniaNaleznosci([
      { id: 'inv-1', internalNumber: 'FV/12/2026', buyerName: 'Acme, sp. z o.o.', buyerNip: '1234567890', paymentDueDate: '2026-11-25', outstanding: 1230.5, daysOverdue: 0 },
    ]);
    expect(z).toHaveLength(1);
    expect(z[0]).toMatchObject({ data: '2026-11-25', uid: 'faktura-inv-1@faktway.pl' });
    expect(z[0]!.tytul).toContain('FV/12/2026');
    expect(z[0]!.opis).toContain('1230,50');
    expect(z[0]!.opis).toContain('Acme, sp. z o.o.');
    expect(JSON.stringify(z)).not.toContain('1234567890');
  });

  it('faktura bez terminu płatności nie trafia do kalendarza', () => {
    expect(
      zdarzeniaNaleznosci([{ id: 'x', internalNumber: 'FV/1', buyerName: null, paymentDueDate: null, outstanding: 10, daysOverdue: 0 }]),
    ).toEqual([]);
  });
});

describe('zdarzeniaCykliczne', () => {
  it('pozycja cykliczna: nazwa i data następnego uruchomienia', () => {
    const z = zdarzeniaCykliczne([{ id: 'r1', name: 'Abonament', next_run_date: '2026-12-01' }]);
    expect(z).toEqual([
      expect.objectContaining({ data: '2026-12-01', uid: 'cykliczna-r1-2026-12-01@faktway.pl', tytul: expect.stringContaining('Abonament') }),
    ]);
  });
});
