/**
 * Zaplecze logowania: to, co sesja (`stan/sesja.tsx`) robi na serwerze i w
 * telefonie. Dwie wersje z tym samym kształtem: Supabase (M5b) i dane
 * przykładowe (M5a, gdy brak adresu bazy). Ekrany o nich nie wiedzą.
 */

/** Teksty błędów jak na stronie (`app/(auth)/login/page.tsx`, `two-factor/page.tsx`). */
export const BLEDY_LOGOWANIA = {
  puste_pola: 'Wpisz e-mail i hasło.',
  zle_dane: 'Nieprawidłowy e-mail lub hasło. Upewnij się, że e-mail jest potwierdzony.',
  google: 'Nie udało się zalogować przez Google. Spróbuj ponownie.',
  zly_kod: 'Kod nieprawidłowy. Sprawdź godzinę w telefonie i wpisz aktualny kod z aplikacji TOTP.',
  za_duzo_prob: 'Zbyt wiele prób. Poczekaj chwilę i spróbuj ponownie.',
  brak_polaczenia: 'Nie możemy się połączyć. Sprawdź internet i spróbuj ponownie.',
  nieznany: 'Coś poszło nie tak. Spróbuj ponownie.',
  /**
   * Logowanie hasłem w aplikacji niedostępne: trasa `POST /logowanie` bez limitów prób (Redis) albo
   * GoTrue odrzucił klucz serwera (`login_unavailable`, M6b); przed M6b odmowa captchy w GoTrue.
   */
  captcha: 'Logowanie w aplikacji jest chwilowo niedostępne. Zaloguj się na faktway.pl albo spróbuj za kilka minut.',
  /** Klient zamknął okno Google: bez komunikatu. */
  anulowane: '',
} as const;
export type KodBledu = keyof typeof BLEDY_LOGOWANIA;

export type Konto = {
  /** Identyfikator użytkownika (GoTrue); klucz danych w pamięci telefonu. */
  id: string;
  email: string;
  imie: string;
  /** Nazwa firmy z danych przykładowych; na prawdziwym koncie przychodzi z `GET /konto` (`stan/dane.tsx`). */
  firma: string;
  metoda: 'haslo' | 'google';
  /** Start bez internetu z sesją z pęku kluczy: dane z poprzedniego otwarcia, świeże po powrocie sieci. */
  bezSieci?: boolean;
};
export type Biometria = { nazwa: string; twarz: boolean };

/** Krok logowania po haśle albo Google: od razu konto albo najpierw kod 2FA. */
export type WynikKroku = { ok: true; konto: Konto; wymagaKodu: boolean } | { ok: false; blad: KodBledu };
export type WynikKodu = { ok: true; konto: Konto } | { ok: false; blad: KodBledu };

export type Zaplecze = {
  /** Sesja zapisana na telefonie przy starcie aplikacji (po pełnym logowaniu, z 2FA). */
  start: () => Promise<Konto | undefined>;
  zaloguj: (email: string, haslo: string) => Promise<WynikKroku>;
  zalogujGoogle: () => Promise<WynikKroku>;
  potwierdzKod: (kod: string) => Promise<WynikKodu>;
  /** Porzucenie kroku 2FA: sesja bez drugiego kroku nie może zostać w telefonie. */
  anulujKod: () => Promise<void>;
  wyloguj: () => Promise<void>;
  /** Wywołane, gdy serwer zakończy sesję sam (np. odebrany dostęp, nieważny token). */
  poWylogowaniu: (sluchacz: () => void) => () => void;
  /** Aplikacja na wierzchu albo w tle: odświeżanie tokenu tylko na wierzchu. */
  naWierzchu: (tak: boolean) => void;
  biometria: () => Promise<Biometria | undefined>;
  /** Pytanie systemu o Face ID. `sama`: przy pokazaniu blokady, nie po dotknięciu przycisku. */
  odblokuj: (opcje: { sama: boolean }) => Promise<boolean>;
  wczytaj: (klucz: string) => Promise<string | null>;
  zapisz: (klucz: string, wartosc: string) => Promise<void>;
};
