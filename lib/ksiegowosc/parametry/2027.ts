import { liczba, nieznana } from './liczba';
import type { ParametryRoku } from './typy';
import {
  BEZ_ZAPOWIEDZI_ZMIAN,
  LIMIT_VAT,
  ODLICZENIE_ZDROWOTNEJ,
  PIT_STAWKI_I_LIMITY,
  PLACA_MINIMALNA_2027,
  STAWKA_ZDROWOTNEJ,
  ZUS_KOMUNIKAT_2026,
  ZUS_SKLADKI_2026,
} from './zrodla';

/**
 * Parametry 2027, stan 5.11.2026.
 *
 * Reguła pewności: liczba potwierdzona w źródle NA 2027 r. ma `wysoka`;
 * stawka ustawowa bez komunikatu na 2027 r. ma `srednia` i powód w `uwagi`.
 * Czego jeszcze nie ogłoszono, ma `wartosc: null` (fail-closed) z terminem,
 * kiedy się pojawi. Kwoty zdrowotnej na ryczałcie znamy dopiero w styczniu
 * 2027 r. (komunikat GUS o IV kw. 2026).
 */
export const PARAMETRY_2027: ParametryRoku = {
  rok: 2027,
  vat: {
    liczby: {
      limitZwolnienia: liczba(24_000_000, 'gr', LIMIT_VAT, 'srednia', { uwagi: BEZ_ZAPOWIEDZI_ZMIAN }),
    },
    sprawdzila: null,
  },
  ryczalt: {
    liczby: {
      stawka17: liczba(1700, 'pb', PIT_STAWKI_I_LIMITY, 'srednia', { uwagi: BEZ_ZAPOWIEDZI_ZMIAN }),
      stawka15: liczba(1500, 'pb', PIT_STAWKI_I_LIMITY, 'srednia', { uwagi: BEZ_ZAPOWIEDZI_ZMIAN }),
      stawka14: liczba(1400, 'pb', PIT_STAWKI_I_LIMITY, 'srednia', { uwagi: BEZ_ZAPOWIEDZI_ZMIAN }),
      stawka12: liczba(1200, 'pb', PIT_STAWKI_I_LIMITY, 'srednia', { uwagi: BEZ_ZAPOWIEDZI_ZMIAN }),
      stawka10: liczba(1000, 'pb', PIT_STAWKI_I_LIMITY, 'srednia', { uwagi: BEZ_ZAPOWIEDZI_ZMIAN }),
      stawka8_5: liczba(850, 'pb', PIT_STAWKI_I_LIMITY, 'srednia', { uwagi: BEZ_ZAPOWIEDZI_ZMIAN }),
      stawka5_5: liczba(550, 'pb', PIT_STAWKI_I_LIMITY, 'srednia', { uwagi: BEZ_ZAPOWIEDZI_ZMIAN }),
      stawka3: liczba(300, 'pb', PIT_STAWKI_I_LIMITY, 'srednia', { uwagi: BEZ_ZAPOWIEDZI_ZMIAN }),
      progStawki8_5: liczba(10_000_000, 'gr', PIT_STAWKI_I_LIMITY, 'srednia', { uwagi: BEZ_ZAPOWIEDZI_ZMIAN }),
      stawkaPonadProg8_5: liczba(1250, 'pb', PIT_STAWKI_I_LIMITY, 'srednia', { uwagi: BEZ_ZAPOWIEDZI_ZMIAN }),
      odliczenieZdrowotnej: liczba(5000, 'pb', ODLICZENIE_ZDROWOTNEJ, 'srednia', { uwagi: BEZ_ZAPOWIEDZI_ZMIAN }),
    },
    sprawdzila: null,
  },
  limity: {
    liczby: {
      ryczaltLimitPrzychodu: nieznana(
        'gr',
        '2 mln euro po kursie NBP z 1.10.2026; MF ogłasza kwotę na podatki.gov.pl („Stawki i limity”) w grudniu 2026 r.',
      ),
      ryczaltLimitKwartalny: nieznana('gr', '200 000 euro po kursie NBP z 1.10.2026; jak wyżej.'),
    },
    sprawdzila: null,
  },
  skala: {
    liczby: {
      stawkaDoProgu: liczba(1200, 'pb', PIT_STAWKI_I_LIMITY, 'srednia', { uwagi: BEZ_ZAPOWIEDZI_ZMIAN }),
      stawkaPonadProg: liczba(3200, 'pb', PIT_STAWKI_I_LIMITY, 'srednia', { uwagi: BEZ_ZAPOWIEDZI_ZMIAN }),
      prog: liczba(12_000_000, 'gr', PIT_STAWKI_I_LIMITY, 'srednia', { uwagi: BEZ_ZAPOWIEDZI_ZMIAN }),
      kwotaZmniejszajaca: liczba(360_000, 'gr', PIT_STAWKI_I_LIMITY, 'srednia', { uwagi: BEZ_ZAPOWIEDZI_ZMIAN }),
    },
    sprawdzila: null,
  },
  liniowy: {
    liczby: {
      stawka: liczba(1900, 'pb', PIT_STAWKI_I_LIMITY, 'srednia', { uwagi: BEZ_ZAPOWIEDZI_ZMIAN }),
      limitOdliczeniaZdrowotnej: nieznana(
        'gr',
        'Roczny limit ogłasza Minister Finansów obwieszczeniem w grudniu (na 2026 r. 14 100 zł).',
      ),
    },
    sprawdzila: null,
  },
  zdrowotna: {
    liczby: {
      stawka: liczba(900, 'pb', ZUS_SKLADKI_2026, 'srednia', { uwagi: BEZ_ZAPOWIEDZI_ZMIAN }),
      stawkaLiniowy: liczba(490, 'pb', STAWKA_ZDROWOTNEJ, 'srednia', { uwagi: BEZ_ZAPOWIEDZI_ZMIAN }),
      przecietneWynagrodzenieIvKw: nieznana(
        'gr',
        'Przeciętne wynagrodzenie za IV kw. 2026 r. z wypłatami z zysku: obwieszczenie Prezesa GUS w styczniu 2027 r.',
      ),
      ryczaltDo60Tys: nieznana('gr', 'Od lutego 2027 r.; znana po komunikacie GUS i ZUS w styczniu 2027 r.'),
      ryczaltDo300Tys: nieznana('gr', 'Od lutego 2027 r.; znana po komunikacie GUS i ZUS w styczniu 2027 r.'),
      ryczaltPonad300Tys: nieznana('gr', 'Od lutego 2027 r.; znana po komunikacie GUS i ZUS w styczniu 2027 r.'),
      progRyczaltu60Tys: liczba(6_000_000, 'gr', ZUS_SKLADKI_2026, 'srednia', { uwagi: BEZ_ZAPOWIEDZI_ZMIAN }),
      progRyczaltu300Tys: liczba(30_000_000, 'gr', ZUS_SKLADKI_2026, 'srednia', { uwagi: BEZ_ZAPOWIEDZI_ZMIAN }),
      minimalna: liczba(44_550, 'gr', `${ZUS_SKLADKI_2026}; ${PLACA_MINIMALNA_2027}`, 'srednia', {
        uwagi:
          'Od lutego 2027 do stycznia 2028: 9 % z 4 950 zł, czyli minimalnego wynagrodzenia z pierwszego ' +
          'dnia roku składkowego (reguła z tabeli ZUS 2026). ZUS potwierdza kwotę w styczniu 2027 r.',
      }),
    },
    sprawdzila: null,
  },
  zus: {
    liczby: {
      placaMinimalna: liczba(495_000, 'gr', PLACA_MINIMALNA_2027, 'wysoka'),
      prognozowanePrzecietneWynagrodzenie: nieznana(
        'gr',
        'Obwieszczenie MRPiPS (zwykle w listopadzie); w projekcie ustawy budżetowej 10 033 zł, nieostateczne.',
      ),
      podstawaPelnaProc: liczba(6000, 'pb', ZUS_KOMUNIKAT_2026, 'srednia', { uwagi: BEZ_ZAPOWIEDZI_ZMIAN }),
      podstawaPreferencyjnaProc: liczba(3000, 'pb', ZUS_KOMUNIKAT_2026, 'srednia', { uwagi: BEZ_ZAPOWIEDZI_ZMIAN }),
      stopaEmerytalna: liczba(1952, 'pb', ZUS_KOMUNIKAT_2026, 'srednia', { uwagi: BEZ_ZAPOWIEDZI_ZMIAN }),
      stopaRentowa: liczba(800, 'pb', ZUS_KOMUNIKAT_2026, 'srednia', { uwagi: BEZ_ZAPOWIEDZI_ZMIAN }),
      stopaChorobowa: liczba(245, 'pb', ZUS_KOMUNIKAT_2026, 'srednia', { uwagi: BEZ_ZAPOWIEDZI_ZMIAN }),
      stopaWypadkowaDoMarca: liczba(167, 'pb', ZUS_SKLADKI_2026, 'srednia', {
        uwagi: 'Rok składkowy od 1.04.2026 do 31.03.2027; ZUS liczy nim kwoty 2026 r.',
      }),
      stopaWypadkowaOdKwietnia: nieznana(
        'pb',
        'Rok składkowy od 1.04.2027: 50 % najwyższej stopy dla grup działalności; ZUS informuje do 20.04.2027.',
      ),
      stopaFunduszPracy: liczba(245, 'pb', ZUS_SKLADKI_2026, 'srednia', { uwagi: BEZ_ZAPOWIEDZI_ZMIAN }),
      ulgaNaStartMiesiecy: liczba(6, 'mies', 'art. 18 ust. 1 ustawy Prawo przedsiębiorców (Dz.U. 2025 poz. 1480)', 'srednia', {
        odczyt: '2026-11-04',
        uwagi: BEZ_ZAPOWIEDZI_ZMIAN,
      }),
      preferencyjnyMiesiecy: liczba(24, 'mies', ZUS_KOMUNIKAT_2026, 'srednia', { uwagi: BEZ_ZAPOWIEDZI_ZMIAN }),
    },
    sprawdzila: null,
  },
};
