import { liczba } from './liczba';
import type { ParametryRoku } from './typy';
import {
  LIMIT_VAT,
  ODLICZENIE_ZDROWOTNEJ,
  PIT_STAWKI_I_LIMITY,
  STAWKA_ZDROWOTNEJ,
  ZUS_KOMUNIKAT_2026,
  ZUS_SKLADKI_2026,
} from './zrodla';

/**
 * Parametry 2026. Każda liczba sprawdzona 5.11.2026 w źródle urzędowym
 * (`zrodla.ts`); `sprawdzila: null`, dopóki nie potwierdzi ich księgowa
 * (warunek B4 w sekcji 11 planu).
 *
 * Kontrola spójności: stopy i podstawy ZUS dają co do grosza kwoty z tabeli
 * ZUS (1 926,76 zł i 456,18 zł), a 9 % podstawy z przeciętnego wynagrodzenia
 * daje kwoty zdrowotnej na ryczałcie. Pilnuje tego
 * `tests/unit/ksiegowosc-parametry.test.ts`.
 */
export const PARAMETRY_2026: ParametryRoku = {
  rok: 2026,
  vat: {
    liczby: {
      limitZwolnienia: liczba(24_000_000, 'gr', LIMIT_VAT, 'wysoka'),
    },
    sprawdzila: null,
  },
  ryczalt: {
    liczby: {
      stawka17: liczba(1700, 'pb', PIT_STAWKI_I_LIMITY, 'wysoka'),
      stawka15: liczba(1500, 'pb', PIT_STAWKI_I_LIMITY, 'wysoka'),
      stawka14: liczba(1400, 'pb', PIT_STAWKI_I_LIMITY, 'wysoka'),
      stawka12: liczba(1200, 'pb', PIT_STAWKI_I_LIMITY, 'wysoka'),
      stawka10: liczba(1000, 'pb', PIT_STAWKI_I_LIMITY, 'wysoka'),
      stawka8_5: liczba(850, 'pb', PIT_STAWKI_I_LIMITY, 'wysoka'),
      stawka5_5: liczba(550, 'pb', PIT_STAWKI_I_LIMITY, 'wysoka'),
      stawka3: liczba(300, 'pb', PIT_STAWKI_I_LIMITY, 'wysoka'),
      progStawki8_5: liczba(10_000_000, 'gr', PIT_STAWKI_I_LIMITY, 'wysoka', {
        uwagi:
          'Próg 100 000 zł przychodu m.in. z najmu składników majątku firmy, zakwaterowania, ' +
          'wynajmu nieruchomości i B+R; od nadwyżki stawka 12,5 %.',
      }),
      stawkaPonadProg8_5: liczba(1250, 'pb', PIT_STAWKI_I_LIMITY, 'wysoka'),
      odliczenieZdrowotnej: liczba(5000, 'pb', ODLICZENIE_ZDROWOTNEJ, 'wysoka', {
        uwagi:
          'Od przychodu odlicza się 50 % zapłaconych składek zdrowotnych. Przy kilku stawkach ' +
          'odliczenie dzieli się proporcjonalnie do przychodów z każdej stawki (ta sama strona).',
      }),
    },
    sprawdzila: null,
  },
  limity: {
    liczby: {
      ryczaltLimitPrzychodu: liczba(851_720_000, 'gr', PIT_STAWKI_I_LIMITY, 'wysoka', {
        uwagi: '2 mln euro po kursie NBP 4,2586 z 1.10.2025; przychód za 2025 r. uprawniający do ryczałtu w 2026 r.',
      }),
      ryczaltLimitKwartalny: liczba(85_172_000, 'gr', PIT_STAWKI_I_LIMITY, 'wysoka', {
        uwagi: '200 000 euro; przychód za 2025 r. pozwalający na ryczałt kwartalny w 2026 r.',
      }),
    },
    sprawdzila: null,
  },
  skala: {
    liczby: {
      stawkaDoProgu: liczba(1200, 'pb', PIT_STAWKI_I_LIMITY, 'wysoka'),
      stawkaPonadProg: liczba(3200, 'pb', PIT_STAWKI_I_LIMITY, 'wysoka'),
      prog: liczba(12_000_000, 'gr', PIT_STAWKI_I_LIMITY, 'wysoka'),
      kwotaZmniejszajaca: liczba(360_000, 'gr', PIT_STAWKI_I_LIMITY, 'wysoka'),
    },
    sprawdzila: null,
  },
  liniowy: {
    liczby: {
      stawka: liczba(1900, 'pb', PIT_STAWKI_I_LIMITY, 'wysoka'),
      limitOdliczeniaZdrowotnej: liczba(1_410_000, 'gr', ODLICZENIE_ZDROWOTNEJ, 'wysoka'),
    },
    sprawdzila: null,
  },
  zdrowotna: {
    liczby: {
      stawka: liczba(900, 'pb', ZUS_SKLADKI_2026, 'wysoka', {
        uwagi: 'Art. 79 ust. 1 ustawy o świadczeniach opieki zdrowotnej (przypis ZUS).',
      }),
      stawkaLiniowy: liczba(490, 'pb', STAWKA_ZDROWOTNEJ, 'wysoka'),
      przecietneWynagrodzenieIvKw: liczba(922_864, 'gr', ZUS_SKLADKI_2026, 'wysoka', {
        uwagi: 'IV kw. 2025 z wypłatami z zysku: obwieszczenie Prezesa GUS z 22.01.2026, M.P. 2026 poz. 117.',
      }),
      ryczaltDo60Tys: liczba(49_835, 'gr', ZUS_SKLADKI_2026, 'wysoka', {
        uwagi: '9 % z 60 % przeciętnego wynagrodzenia (podstawa 5 537,18 zł).',
      }),
      ryczaltDo300Tys: liczba(83_058, 'gr', ZUS_SKLADKI_2026, 'wysoka', {
        uwagi: '9 % ze 100 % przeciętnego wynagrodzenia (podstawa 9 228,64 zł).',
      }),
      ryczaltPonad300Tys: liczba(149_504, 'gr', ZUS_SKLADKI_2026, 'wysoka', {
        uwagi: '9 % ze 180 % przeciętnego wynagrodzenia (podstawa 16 611,55 zł).',
      }),
      progRyczaltu60Tys: liczba(6_000_000, 'gr', ZUS_SKLADKI_2026, 'wysoka', {
        uwagi: 'Przychód osiągnięty od początku roku kalendarzowego (art. 81 ust. 2f).',
      }),
      progRyczaltu300Tys: liczba(30_000_000, 'gr', ZUS_SKLADKI_2026, 'wysoka'),
      minimalna: liczba(43_254, 'gr', ZUS_SKLADKI_2026, 'wysoka', {
        uwagi:
          'Skala i liniowy, od lutego 2026 do stycznia 2027: 9 % z 4 806 zł (minimalne ' +
          'wynagrodzenie z pierwszego dnia roku składkowego).',
      }),
    },
    sprawdzila: null,
  },
  zus: {
    liczby: {
      placaMinimalna: liczba(480_600, 'gr', ZUS_KOMUNIKAT_2026, 'wysoka', {
        uwagi: 'Rozporządzenie Rady Ministrów z 11.09.2025, Dz.U. 2025 poz. 1242.',
      }),
      prognozowanePrzecietneWynagrodzenie: liczba(942_000, 'gr', ZUS_KOMUNIKAT_2026, 'wysoka', {
        uwagi: 'Obwieszczenie MRPiPS z 19.11.2025, M.P. 2025 poz. 1206.',
      }),
      podstawaPelnaProc: liczba(6000, 'pb', ZUS_KOMUNIKAT_2026, 'wysoka', {
        uwagi: 'Art. 18 ust. 8 ustawy o systemie ubezpieczeń społecznych: podstawa 5 652 zł.',
      }),
      podstawaPreferencyjnaProc: liczba(3000, 'pb', ZUS_KOMUNIKAT_2026, 'wysoka', {
        uwagi: 'Art. 18a ustawy o systemie ubezpieczeń społecznych: podstawa 1 441,80 zł.',
      }),
      stopaEmerytalna: liczba(1952, 'pb', ZUS_KOMUNIKAT_2026, 'wysoka'),
      stopaRentowa: liczba(800, 'pb', ZUS_KOMUNIKAT_2026, 'wysoka'),
      stopaChorobowa: liczba(245, 'pb', ZUS_KOMUNIKAT_2026, 'wysoka'),
      stopaWypadkowaDoMarca: liczba(167, 'pb', ZUS_SKLADKI_2026, 'srednia', {
        uwagi:
          'Rok składkowy od 1.04.2025. ZUS liczy kwoty 2026 r. stopą 1,67 %; płatnik do 9 osób ' +
          'stosuje 50 % najwyższej stopy dla grup (art. 28 ust. 1 ustawy wypadkowej).',
      }),
      stopaWypadkowaOdKwietnia: liczba(167, 'pb', ZUS_SKLADKI_2026, 'srednia', {
        uwagi: 'Rok składkowy od 1.04.2026 do 31.03.2027; ta sama tabela ZUS na cały 2026 r.',
      }),
      stopaFunduszPracy: liczba(245, 'pb', ZUS_SKLADKI_2026, 'wysoka', {
        uwagi:
          'Fundusz Pracy i Fundusz Solidarnościowy razem. W tabeli ZUS jest przy podstawie ' +
          'pełnej, a przy preferencyjnej go nie ma.',
      }),
      ulgaNaStartMiesiecy: liczba(6, 'mies', 'art. 18 ust. 1 ustawy Prawo przedsiębiorców (Dz.U. 2025 poz. 1480)', 'srednia', {
        odczyt: '2026-11-04',
        uwagi:
          'Liczba miesięcy z planu (sekcja 5, odczyt 4.11.2026), bez ponownego odczytu ustawy. ' +
          'Ulga zwalnia tylko ze składek społecznych, zdrowotna płatna (ZUS, tabela 2026, pkt 3).',
      }),
      preferencyjnyMiesiecy: liczba(24, 'mies', ZUS_KOMUNIKAT_2026, 'wysoka', {
        uwagi: 'Art. 18a ustawy o systemie ubezpieczeń społecznych: pierwsze 24 miesiące kalendarzowe.',
      }),
    },
    sprawdzila: null,
  },
};
