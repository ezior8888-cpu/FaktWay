/**
 * Plan pliku przelewów (krok 3.4, część 2): z zaznaczonych kosztów kandydaci
 * do pliku (rekord Elixir-0 bez sprawdzenia białej listy) i koszty poza
 * plikiem z powodem. Kolejność sprawdzeń wyznacza pierwszy powód, który
 * klient zobaczy: rachunek, faktor, MPP nieczytelne, problemy odczytu, kilka
 * terminów, wpłaty częściowe, numer KSeF, nazwa, kwota, MPP w banku, tytuł.
 * Typy, stałe i teksty: `plik-przelewow.ts`.
 */

import { listaDoZaplaty, type KosztDoZaplaty } from '@/lib/expenses/do-zaplaty';
import {
  bankObslugujeMppWElixir,
  komunikatMpp,
  kwotaWGroszach,
  liniePo35,
  nrb,
  poleNazwyElixir,
  tekstElixir,
} from '@/lib/expenses/elixir0';
import {
  dataPl,
  dataWykonania,
  POWODY,
  W_BANKOWOSCI,
  type KandydatPrzelewu,
  type KodPominiecia,
  type NadawcaPliku,
  type PominietyKoszt,
  type WierszKosztuDoPliku,
} from '@/lib/expenses/plik-przelewow';
import { uwagiPlatnosci } from '@/lib/expenses/platnosc-kosztu';
import { roundToCents } from '@/lib/xml/invoice-calculator';

function terminy(n: number): string {
  const ostatnia = n % 10;
  const nastolatki = n % 100 >= 12 && n % 100 <= 14;
  return ostatnia >= 2 && ostatnia <= 4 && !nastolatki ? `${n} terminy` : `${n} terminów`;
}

/**
 * Plan pliku: kolejność jak na liście (od najbliższego terminu), pominięte
 * w kolejności zaznaczenia. `wiersze` to wiersze zaznaczonych kosztów (RLS
 * i środowisko KSeF filtruje odczyt), `ids` to zaznaczenie z ekranu.
 */
export function planPlikuPrzelewow(input: {
  wiersze: readonly WierszKosztuDoPliku[];
  ids: readonly string[];
  nadawca: NadawcaPliku;
  dzis: string;
}): { kandydaci: KandydatPrzelewu[]; pominiete: PominietyKoszt[]; bladNadawcy: string | null } {
  const { wiersze, ids, nadawca, dzis } = input;
  const poleNadawcy = poleNazwyElixir([nadawca.nazwa, ...nadawca.adres]);
  if (!poleNadawcy) {
    return {
      kandydaci: [],
      pominiete: [],
      bladNadawcy: 'Nazwy firmy nie da się zapisać znakami, które przyjmuje plik banku. Popraw nazwę w Ustawieniach, w danych firmy.',
    };
  }

  const wierszWgId = new Map(wiersze.map((w) => [w.id, w]));
  const lista = listaDoZaplaty(wiersze, dzis);
  const pozycjaWgId = new Map(lista.pozycje.map((p) => [p.id, p]));
  const pominiete: PominietyKoszt[] = [];
  const pomin = (id: string, w: WierszKosztuDoPliku | undefined, kod: KodPominiecia, powod: string) =>
    pominiete.push({
      id,
      sprzedawca: w?.seller_name ?? 'Nieznany koszt',
      numerFaktury: w?.faktura?.internal_number?.trim() || w?.document_number?.trim() || '',
      kod,
      powod,
    });

  for (const id of ids) {
    const w = wierszWgId.get(id);
    if (!w) {
      pomin(id, w, 'nie_znaleziono', POWODY.nie_znaleziono);
      continue;
    }
    if (w.paid_at) {
      pomin(id, w, 'zaplacony', `Koszt jest już oznaczony jako zapłacony (${dataPl(w.paid_at)}), więc nie ma go w pliku.`);
      continue;
    }
    if (pozycjaWgId.has(id)) continue;
    const waluta = w.faktura?.currency?.trim().toUpperCase();
    if (w.faktura && waluta && waluta !== 'PLN' && w.payment_due_date && Number(w.gross_amount) > 0) {
      pomin(id, w, 'waluta', `Kwota do zapłaty jest w walucie ${waluta}, a plik Elixir-0 to przelewy krajowe w złotych. ${W_BANKOWOSCI}`);
      continue;
    }
    pomin(id, w, 'spoza_listy', POWODY.spoza_listy);
  }

  const zaznaczone = new Set(ids);
  const kandydaci: KandydatPrzelewu[] = [];
  for (const koszt of lista.pozycje) {
    if (!zaznaczone.has(koszt.id)) continue;
    const w = wierszWgId.get(koszt.id)!;
    const powod = powodPominieciaPozycji(koszt, w, nadawca);
    if ('kod' in powod) {
      pomin(koszt.id, w, powod.kod, powod.tekst);
      continue;
    }
    kandydaci.push({
      koszt,
      przelew: {
        dataWykonania: dataWykonania(koszt.termin, dzis),
        kwotaGrosze: powod.kwotaGrosze,
        rachunekNadawcy: nadawca.rachunek,
        rachunekOdbiorcy: powod.rachunek,
        nadawca: poleNadawcy,
        odbiorca: powod.odbiorca,
        tytul: powod.tytul,
        mpp: koszt.mpp === true,
      },
      bialaLista: koszt.wymagaBialejListy ? { nip: powod.nip } : null,
    });
  }

  const kolejnosc = new Map(ids.map((id, i) => [id, i]));
  pominiete.sort((a, b) => (kolejnosc.get(a.id) ?? 0) - (kolejnosc.get(b.id) ?? 0));
  return { kandydaci, pominiete, bladNadawcy: null };
}

type WynikPozycji =
  | { kod: KodPominiecia; tekst: string }
  | { kwotaGrosze: number; rachunek: string; odbiorca: string; tytul: string; nip: string };

function powodPominieciaPozycji(koszt: KosztDoZaplaty, w: WierszKosztuDoPliku, nadawca: NadawcaPliku): WynikPozycji {
  const fakty = uwagiPlatnosci(w.payment_terms);

  if (!koszt.rachunek) return { kod: 'brak_rachunku', tekst: POWODY.brak_rachunku };
  const rachunek = nrb(koszt.rachunek);
  if (!rachunek) {
    const zagraniczny = /^[A-Z]{2}/i.test(koszt.rachunek.replace(/\s/g, '')) && !/^PL/i.test(koszt.rachunek.replace(/\s/g, ''));
    return zagraniczny
      ? { kod: 'rachunek_zagraniczny', tekst: POWODY.rachunek_zagraniczny }
      : { kod: 'rachunek_bledny', tekst: POWODY.rachunek_bledny };
  }
  if (fakty?.rachunekFaktora) return { kod: 'rachunek_faktora', tekst: POWODY.rachunek_faktora };
  if (koszt.mpp === null) return { kod: 'mpp_nieczytelne', tekst: POWODY.mpp_nieczytelne };
  if (fakty && fakty.problemy.length > 0) {
    return {
      kod: 'problemy_odczytu',
      tekst: `Części danych płatności nie dało się odczytać z pliku KSeF (${fakty.problemy.join('; ')}). Sprawdź je w fakturze. ${W_BANKOWOSCI}`,
    };
  }
  if ((fakty?.liczbaTerminow ?? 0) > 1) {
    return {
      kod: 'kilka_terminow',
      tekst: `Faktura podaje ${terminy(fakty!.liczbaTerminow)} płatności, a plik nie dzieli kwoty na raty. Zapłać raty w bankowości według faktury.`,
    };
  }
  const czesciowo = fakty?.zaplaconoCzesciowo ?? null;
  if (czesciowo !== null && !(czesciowo > 0 && czesciowo < koszt.brutto)) {
    return { kod: 'wplaty_czesciowe', tekst: POWODY.wplaty_czesciowe };
  }
  if (!koszt.numerKsef) return { kod: 'brak_numeru_ksef', tekst: POWODY.brak_numeru_ksef };

  const odbiorca = poleNazwyElixir([koszt.sprzedawca, w.seller_address]);
  if (!odbiorca) return { kod: 'nazwa', tekst: POWODY.nazwa };
  const kwotaGrosze = kwotaWGroszach(koszt.kwota);
  if (kwotaGrosze === null) return { kod: 'spoza_listy', tekst: POWODY.spoza_listy };
  const nip = koszt.nip?.replace(/\D/g, '') ?? '';

  let tytul: string | null;
  if (koszt.mpp) {
    if (!bankObslugujeMppWElixir(nadawca.rachunek)) return { kod: 'mpp_bank', tekst: POWODY.mpp_bank };
    // Przy wpłatach częściowych nie wiadomo, ile VAT już zapłacono: kwota VAT do komunikatu zostaje człowiekowi.
    const vatPewny = czesciowo === null && koszt.vat > 0 && roundToCents(koszt.vat) <= koszt.kwota;
    const komunikat = vatPewny
      ? komunikatMpp({ vat: koszt.vat, nip, numerKsef: koszt.numerKsef, tekst: koszt.numerFaktury })
      : null;
    if (!komunikat) return { kod: 'mpp_dane', tekst: POWODY.mpp_dane };
    tytul = liniePo35(komunikat);
  } else {
    tytul = liniePo35(tekstElixir(koszt.tytul)) ?? liniePo35(koszt.numerKsef);
  }
  if (!tytul) return { kod: 'tytul', tekst: POWODY.tytul };
  return { kwotaGrosze, rachunek, odbiorca, tytul, nip };
}

/** Kwota łącznie (zł) z groszy przelewów. */
export function sumaPrzelewow(przelewy: ReadonlyArray<{ kwotaGrosze: number }>): number {
  return roundToCents(przelewy.reduce((s, p) => s + p.kwotaGrosze, 0) / 100);
}
