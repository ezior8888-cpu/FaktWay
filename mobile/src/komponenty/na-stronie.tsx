/**
 * Zmiana prawdziwej faktury, której API telefonu jeszcze nie ma (od M8
 * wystawienie zwykłej faktury i wysyłka szkicu idą przez API; korekta,
 * zaliczka, rozliczenie, zmiana szkicu, zapłata, e-mail i przypomnienia w M10).
 * Telefon nie udaje zapisu: mówi, gdzie to zrobić, i otwiera tę samą
 * fakturę na stronie. Systemowy arkusz akcji jak `potwierdz()`.
 */
import { Stack, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { ActionSheetIOS, Alert, Platform } from 'react-native';

import { EkranListy } from '@/komponenty/lista';
import { StanPusty } from '@/komponenty/stan-pusty';
import { ADRES_API } from '@/lib/api/polaczenie';

export type ZmianaNaStronie = 'zaplata' | 'wystawienie' | 'edycja' | 'wysylka' | 'email' | 'przypomnienie' | 'cykliczna' | 'pdf';

const TYTULY: Record<ZmianaNaStronie, string> = {
  zaplata: 'Zapłatę oznaczysz na faktway.pl',
  wystawienie: 'Fakturę wystawisz na faktway.pl',
  edycja: 'Szkic zmienisz na faktway.pl',
  wysylka: 'Do KSeF wyślesz na faktway.pl',
  email: 'E-mail z fakturą wyślesz na faktway.pl',
  przypomnienie: 'Przypomnienie wyślesz na faktway.pl',
  cykliczna: 'Faktury cykliczne ustawisz na faktway.pl',
  pdf: 'PDF i XML pobierzesz na faktway.pl',
};

export const OPIS_NA_STRONIE = 'Ta wersja aplikacji pokazuje faktury z Twojego konta. Zmiany zapiszesz na razie na stronie; z telefonu dojdą w kolejnych wersjach.';

/** Adres na stronie: faktura, nowa faktura albo lista. Lokalnie to `EXPO_PUBLIC_API_URL`. */
function adresNaStronie(co: ZmianaNaStronie, idFaktury?: string): string | undefined {
  if (!ADRES_API) return undefined;
  const baza = ADRES_API.replace(/\/+$/, '');
  if (idFaktury) return `${baza}/invoices/${encodeURIComponent(idFaktury)}`;
  if (co === 'wystawienie') return `${baza}/invoices/new`;
  if (co === 'cykliczna') return `${baza}/invoices/recurring`;
  return `${baza}/invoices`;
}

export function otworzNaStronie(co: ZmianaNaStronie, idFaktury?: string): void {
  const adres = adresNaStronie(co, idFaktury);
  if (adres) void WebBrowser.openBrowserAsync(adres);
}

/** Dowolna strona panelu, np. `/expenses/<id>`; bez adresu serwera nic nie robi. */
export function otworzStrone(sciezka: string): void {
  if (ADRES_API) void WebBrowser.openBrowserAsync(`${ADRES_API.replace(/\/+$/, '')}${sciezka}`);
}

export const MA_ADRES_STRONY = Boolean(ADRES_API);

/**
 * Wydatek, którego telefon nie zapisze (M9): koszt z KSeF (porównanie z XML
 * i kursem), usunięcie albo wpis ręczny. Arkusz akcji z „Otwórz na stronie”.
 */
export function wydatekNaStronie(idWydatku?: string): void {
  const tytul = idWydatku ? 'Ten wydatek zmienisz na faktway.pl' : 'Wydatek bez zdjęcia wpiszesz na faktway.pl';
  const opis = idWydatku
    ? 'Z telefonu opiszesz wydatek ze zdjęcia. Wydatek z KSeF porównasz z fakturą, a usuniesz go na stronie.'
    : 'Z telefonu dodasz wydatek ze zdjęcia albo skanu. Ręczny wpis dojdzie w kolejnej wersji aplikacji.';
  const sciezka = idWydatku ? `/expenses/${encodeURIComponent(idWydatku)}` : '/expenses';
  const otworz = idWydatku ? 'Otwórz wydatek na stronie' : 'Otwórz faktway.pl';
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions({ title: tytul, message: opis, options: [otworz, 'Zamknij'], cancelButtonIndex: 1 }, (i) => {
      if (i === 0) otworzStrone(sciezka);
    });
    return;
  }
  Alert.alert(tytul, opis, [{ text: 'Zamknij', style: 'cancel' }, { text: otworz, onPress: () => otworzStrone(sciezka) }]);
}

export function naStronie(co: ZmianaNaStronie, idFaktury?: string): void {
  const otworz = idFaktury ? 'Otwórz fakturę na stronie' : 'Otwórz faktway.pl';
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions({ title: TYTULY[co], message: OPIS_NA_STRONIE, options: [otworz, 'Zamknij'], cancelButtonIndex: 1 }, (i) => {
      if (i === 0) otworzNaStronie(co, idFaktury);
    });
    return;
  }
  Alert.alert(TYTULY[co], OPIS_NA_STRONIE, [
    { text: 'Zamknij', style: 'cancel' },
    { text: otworz, onPress: () => otworzNaStronie(co, idFaktury) },
  ]);
}

/** Ekran zamiast formularza, który na prawdziwym koncie jeszcze nie zapisuje (wystawienie, e-mail, przypomnienie). */
export function TylkoNaStronie({ co, idFaktury }: { co: ZmianaNaStronie; idFaktury?: string }) {
  return (
    <StanPusty
      ikona="macbook-line"
      tytul={TYTULY[co]}
      opis={OPIS_NA_STRONIE}
      akcja={ADRES_API ? { tytul: idFaktury ? 'Otwórz fakturę na stronie' : 'Otwórz faktway.pl', onPress: () => otworzNaStronie(co, idFaktury) } : undefined}
    />
  );
}

/**
 * Cały ekran (arkusz) zamiast formularza na prawdziwym koncie, z „Zamknij”
 * w pasku. Ekrany z danymi przykładowymi zostają bez zmian.
 */
export function EkranTylkoNaStronie({ co, idFaktury }: { co: ZmianaNaStronie; idFaktury?: string }) {
  const router = useRouter();
  return (
    <>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={() => router.back()}>Zamknij</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <EkranListy>
        <TylkoNaStronie co={co} idFaktury={idFaktury} />
      </EkranListy>
    </>
  );
}
