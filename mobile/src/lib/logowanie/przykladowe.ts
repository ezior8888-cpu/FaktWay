/**
 * Zaplecze logowania na danych przykładowych (M5a), gdy aplikacja nie ma
 * adresu bazy. Hasło od 8 znaków przechodzi, krótsze daje błąd złych danych;
 * kod 2FA to dowolne 6 cyfr poza „000000”. Start: klient wraca do aplikacji
 * z włączoną blokadą Face ID, więc widać od razu ekran blokady.
 */
import { Platform } from 'react-native';

import { CZLONKOWIE, FIRMA } from '@/dane-przykladowe/ustawienia';
import type { Konto, Zaplecze } from '@/lib/logowanie/typy';

function konto(email?: string, metoda: Konto['metoda'] = 'haslo'): Konto {
  const ty = CZLONKOWIE.find((c) => c.ty) ?? CZLONKOWIE[0];
  return { email: email ?? ty.email, imie: ty.imie, firma: FIRMA.nazwa, metoda };
}

/** Czas odpowiedzi serwera, żeby było widać stan „trwa logowanie”. */
const czekaj = () => new Promise<void>((r) => setTimeout(r, 700));

/** Kod 2FA „wymagany” zawsze; sesja pomija go, gdy przełącznik 2FA w Więcej, Bezpieczeństwo jest wyłączony. */
export function zapleczePrzykladowe(): Zaplecze {
  const pamiec = new Map<string, string>([
    ['blokada', '1'],
    ['propozycja-face-id', '1'],
    ['email', konto().email],
  ]);
  return {
    start: async () => konto(),
    zaloguj: async (email, haslo) => {
      await czekaj();
      if (haslo.length < 8) return { ok: false, blad: 'zle_dane' };
      return { ok: true, konto: konto(email, 'haslo'), wymagaKodu: true };
    },
    zalogujGoogle: async () => {
      await czekaj();
      return { ok: true, konto: konto(undefined, 'google'), wymagaKodu: true };
    },
    potwierdzKod: async (kod) => {
      await czekaj();
      return kod === '000000' ? { ok: false, blad: 'zly_kod' } : { ok: true, konto: konto() };
    },
    anulujKod: async () => undefined,
    wyloguj: async () => undefined,
    poWylogowaniu: () => () => undefined,
    naWierzchu: () => undefined,
    biometria: async () => (Platform.OS === 'ios' ? { nazwa: 'Face ID', twarz: true } : { nazwa: 'odcisk palca', twarz: false }),
    // Bez pytania systemu samo pokazanie blokady zachowuje się jak anulowane
    // pytanie: zostaje ekran z „Odblokuj”, które zawsze przechodzi.
    odblokuj: async ({ sama }) => !sama,
    wczytaj: async (klucz) => pamiec.get(klucz) ?? null,
    zapisz: async (klucz, wartosc) => {
      pamiec.set(klucz, wartosc);
    },
  };
}
