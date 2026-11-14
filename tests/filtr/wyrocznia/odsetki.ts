// Wyrocznia odsetek za opóźnienie i rekompensaty (czysty pokój, tylko ze SPEC-odsetki.md).

const GRANICA_5000_GR = 500_000; // 5 000,00 zł
const GRANICA_50000_GR = 5_000_000; // 50 000,00 zł
const DNI_W_ROKU = 365;
const DOBA_MS = 86_400_000;

/** Rekompensata (art. 10 ust. 1) w euro dla kwoty świadczenia w groszach. */
export function rekompensataEur(kwotaGr: number): 40 | 70 | 100 {
  if (!Number.isInteger(kwotaGr) || kwotaGr < 0) {
    throw new Error(`Nieprawidłowa kwota w groszach: ${kwotaGr}`);
  }
  // Wątpliwość: kwota 0 zł nie jest w SPEC wymieniona; "nie przekracza 5 000 zł" daje 40 euro.
  if (kwotaGr <= GRANICA_5000_GR) return 40;
  if (kwotaGr < GRANICA_50000_GR) return 70;
  return 100;
}

/** Punkty bazowe (1 pb = 0,01 pp) ze stopy ułamkowej, bez szumu zmiennoprzecinkowego. */
function naPunktyBazowe(stopa: number): number {
  return Math.round(stopa * 10_000);
}

/** Art. 481 KC: stopa referencyjna + 5,5 pp. */
export function stawkaUstawowa(stopaReferencyjna: number): number {
  return (naPunktyBazowe(stopaReferencyjna) + 550) / 10_000;
}

/** Transakcje handlowe: stopa referencyjna (na 1 I / 1 VII) + 10 pp. */
export function stawkaHandlowa(stopaReferencyjna: number): number {
  return (naPunktyBazowe(stopaReferencyjna) + 1000) / 10_000;
}

/** Niezmiennik z SPEC (sekcja 2): różnica stawek przy tej samej stopie (4,5 pp). */
export const ROZNICA_HANDLOWA_USTAWOWA: number =
  Math.round((stawkaHandlowa(0) - stawkaUstawowa(0)) * 10_000) / 10_000;

/** Numer doby (UTC) z daty RRRR-MM-DD. */
function numerDnia(data: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data);
  if (!m) throw new Error(`Nieprawidłowa data: ${data}`);
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DOBA_MS);
}

/**
 * Odsetki dokładne (bez zaokrągleń) w groszach za dni z przedziału [od, doDnia).
 * Sumowane po odcinkach o stałej stawce: kwota * stawka * dni / 365.
 */
export function odsetkiDokladne(
  kwotaGr: number,
  od: string,
  doDnia: string,
  stawki: readonly { od: string; stawka: number }[],
): { dni: number; groszeDokladne: number } {
  if (kwotaGr <= 0) return { dni: 0, groszeDokladne: 0 };
  const start = numerDnia(od);
  const koniec = numerDnia(doDnia);
  if (koniec <= start) return { dni: 0, groszeDokladne: 0 };

  // Wątpliwość: tabela ma być posortowana rosnąco; mimo to sortuję kopię dla pewności.
  const tabela = stawki
    .map((s) => ({ dzien: numerDnia(s.od), stawka: s.stawka }))
    .sort((a, b) => a.dzien - b.dzien);

  let suma = 0;
  let dzien = start;
  while (dzien < koniec) {
    // Ostatnia pozycja o dacie <= dzień (przy równych datach wygrywa późniejsza w tabeli).
    let idx = -1;
    for (let i = 0; i < tabela.length && tabela[i].dzien <= dzien; i++) idx = i;
    // Początek następnego odcinka: kolejna pozycja tabeli po bieżącej albo koniec okresu.
    const nastepny = tabela[idx + 1] ? tabela[idx + 1].dzien : koniec;
    const kraniec = Math.min(Math.max(nastepny, dzien + 1), koniec);
    // Wątpliwość: dzień bez pozycji w tabeli (przed pierwszą) daje 0 odsetek.
    if (idx >= 0) suma += (kwotaGr * tabela[idx].stawka * (kraniec - dzien)) / DNI_W_ROKU;
    dzien = kraniec;
  }
  return { dni: koniec - start, groszeDokladne: suma };
}
