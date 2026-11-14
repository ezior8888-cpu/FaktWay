/**
 * Należności na telefonie (M10a) bez React Native: podpis stanu przypomnień,
 * powód, dla którego nie da się teraz przygotować przypomnienia (te same
 * reguły i zdania co strona „Po terminie”), i bezpieczna nazwa pliku PDF.
 * Import względny, bo czytają go testy strony (`tests/unit/mobile-naleznosci.test.ts`).
 */
import type { NaleznoscTelefonu } from './api/kontrakt';

export type KolorPodpisu = 'akcent' | 'ostrzezenie' | 'blad' | 'sukces' | 'etykietaDrugorzedna';

/** Podpis stanu przypomnień w wierszu, jak kolumna „Status” strony „Po terminie”. */
export function podpisPrzypomnien(n: NaleznoscTelefonu): { tekst: string; kolor: KolorPodpisu } {
  if (n.wstrzymane) return { tekst: 'Wstrzymane', kolor: 'etykietaDrugorzedna' };
  if (n.kolejka === 'do_sprawdzenia') return { tekst: 'Do sprawdzenia', kolor: 'ostrzezenie' };
  if (n.kolejka === 'zaplanowane') return { tekst: 'Zaplanowane', kolor: 'akcent' };
  if (n.ostatnie === 'nieznany' || n.kolejka === 'nieznany') return { tekst: 'Stan niedostępny', kolor: 'etykietaDrugorzedna' };
  if (!n.ostatnie) return { tekst: 'Bez przypomnień', kolor: 'etykietaDrugorzedna' };
  const etap = `Etap ${n.ostatnie.etap}`;
  if (n.ostatnie.status === 'sent') return { tekst: `${etap} · wysłane`, kolor: 'sukces' };
  if (n.ostatnie.status === 'failed') return { tekst: `${etap} · nieudane`, kolor: 'blad' };
  if (n.ostatnie.status === 'cancelled') return { tekst: `${etap} · anulowane`, kolor: 'etykietaDrugorzedna' };
  return { tekst: `${etap} · zaplanowane`, kolor: 'akcent' };
}

/**
 * Powód, dla którego przygotowanie przypomnienia jest zablokowane; `undefined`, gdy można.
 * Jak `canPrepareReminder` strony: tylko bez wstrzymania i bez przypomnienia w kolejce.
 */
export function powodBezPodgladu(n: NaleznoscTelefonu): string | undefined {
  if (n.wstrzymane) return 'Przypomnienia wstrzymane';
  if (n.kolejka === 'zaplanowane') return 'Przypomnienie już zlecone';
  if (n.kolejka === 'do_sprawdzenia') return 'Wysyłka wymaga weryfikacji';
  if (n.kolejka === 'nieznany') return 'Stan wysyłki niedostępny';
  return undefined;
}

/** Nazwa pliku bez ukośników i znaków sterujących, zawsze z `.pdf`. */
export function nazwaPlikuPdf(nazwa: string): string {
  const czysta = nazwa.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim() || 'faktura';
  return /\.pdf$/i.test(czysta) ? czysta : `${czysta}.pdf`;
}
