/**
 * Zaplecze logowania na prawdziwym koncie (M5b): Supabase (GoTrue) tak jak na
 * stronie, Face ID przez `expo-local-authentication`, sesja i ustawienia w
 * pęku kluczy (`lib/supabase.ts`).
 *
 * Kolejność jak na stronie (`app/(auth)/login/actions.ts`, `two-factor`):
 * hasło albo Google daje sesję na poziomie `aal1`; gdy konto ma TOTP, sesja
 * przechodzi na `aal2` dopiero po kodzie. Sesja bez drugiego kroku nie zostaje
 * w telefonie (`anulujKod`, `start`).
 */
import { isAuthRetryableFetchError, type SupabaseClient, type User } from '@supabase/supabase-js';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

import { FIRMA } from '@/dane-przykladowe/ustawienia';
import type { KodBledu, Konto, WynikKroku, Zaplecze } from '@/lib/logowanie/typy';
import { ustawienia } from '@/lib/supabase';

/** Błąd GoTrue na kod komunikatu; `domyslny` dla odrzuconych danych (hasło, kod). */
function kodBledu(blad: unknown, domyslny: KodBledu): KodBledu {
  if (isAuthRetryableFetchError(blad)) return 'brak_polaczenia';
  // Jak `isGoTrueCaptchaRejection` na stronie (`lib/security/bot-check.ts`): kod `captcha_failed` albo „captcha” w treści.
  if (typeof blad === 'object' && blad !== null) {
    const { code, message } = blad as { code?: unknown; message?: unknown };
    if (code === 'captcha_failed' || (typeof message === 'string' && /captcha/i.test(message))) return 'captcha';
  }
  const status = typeof blad === 'object' && blad !== null && 'status' in blad ? blad.status : undefined;
  if (status === 429) return 'za_duzo_prob';
  if (typeof status === 'number' && status >= 500) return 'nieznany';
  return domyslny;
}

function konto(uzytkownik: User): Konto {
  const meta: Record<string, unknown> = uzytkownik.user_metadata ?? {};
  const email = uzytkownik.email ?? '';
  // Bez imienia w profilu zostaje pusty napis: blokada wita wtedy bez imienia, a nie częścią adresu e-mail.
  const imie = [meta.full_name, meta.name].find((x): x is string => typeof x === 'string' && x.trim() !== '')?.trim() ?? '';
  return {
    email,
    imie,
    // Firma przyjdzie z bazy razem z danymi (M7); do tego czasu dane przykładowe.
    firma: FIRMA.nazwa,
    metoda: uzytkownik.app_metadata?.provider === 'google' ? 'google' : 'haslo',
  };
}

export function zapleczeSupabase(supabase: SupabaseClient): Zaplecze {
  /** Czy sesja po pierwszym kroku czeka jeszcze na kod (konto z TOTP). */
  async function wymagaKodu(): Promise<boolean> {
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    return data?.nextLevel === 'aal2' && data.currentLevel !== 'aal2';
  }

  async function poPierwszymKroku(uzytkownik: User): Promise<WynikKroku> {
    return { ok: true, konto: konto(uzytkownik), wymagaKodu: await wymagaKodu() };
  }

  return {
    start: async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) return undefined;
      if (await wymagaKodu()) {
        await supabase.auth.signOut({ scope: 'local' });
        return undefined;
      }
      return konto(data.session.user);
    },

    zaloguj: async (email, haslo) => {
      try {
        const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password: haslo });
        if (error || !data.user) return { ok: false, blad: kodBledu(error, 'zle_dane') };
        return await poPierwszymKroku(data.user);
      } catch (e) {
        return { ok: false, blad: kodBledu(e, 'nieznany') };
      }
    },

    zalogujGoogle: async () => {
      try {
        // Adres powrotu musi być na liście GoTrue (`GOTRUE_URI_ALLOW_LIST`, lokalnie `additional_redirect_urls`).
        const powrot = Linking.createURL('logowanie');
        const { data, error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: powrot, skipBrowserRedirect: true } });
        if (error || !data.url) return { ok: false, blad: kodBledu(error, 'google') };
        const wynik = await WebBrowser.openAuthSessionAsync(data.url, powrot);
        if (wynik.type !== 'success') return { ok: false, blad: 'anulowane' };
        const kod = Linking.parse(wynik.url).queryParams?.code;
        if (typeof kod !== 'string') return { ok: false, blad: 'google' };
        const wymiana = await supabase.auth.exchangeCodeForSession(kod);
        if (wymiana.error || !wymiana.data.user) return { ok: false, blad: kodBledu(wymiana.error, 'google') };
        return await poPierwszymKroku(wymiana.data.user);
      } catch (e) {
        return { ok: false, blad: kodBledu(e, 'google') };
      }
    },

    potwierdzKod: async (kod) => {
      try {
        const czynniki = await supabase.auth.mfa.listFactors();
        const totp = czynniki.data?.totp[0];
        if (czynniki.error || !totp) return { ok: false, blad: kodBledu(czynniki.error, 'nieznany') };
        const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: totp.id, code: kod });
        if (error) return { ok: false, blad: kodBledu(error, 'zly_kod') };
        const { data } = await supabase.auth.getUser();
        return data.user ? { ok: true, konto: konto(data.user) } : { ok: false, blad: 'nieznany' };
      } catch (e) {
        return { ok: false, blad: kodBledu(e, 'nieznany') };
      }
    },

    anulujKod: async () => {
      await supabase.auth.signOut({ scope: 'local' });
    },

    wyloguj: async () => {
      // `local`: kończy sesję tego telefonu (także na serwerze), komputer zostaje zalogowany.
      await supabase.auth.signOut({ scope: 'local' });
    },

    poWylogowaniu: (sluchacz) => {
      const { data } = supabase.auth.onAuthStateChange((zdarzenie) => {
        if (zdarzenie === 'SIGNED_OUT') sluchacz();
      });
      return () => data.subscription.unsubscribe();
    },

    naWierzchu: (tak) => {
      if (tak) void supabase.auth.startAutoRefresh();
      else void supabase.auth.stopAutoRefresh();
    },

    biometria: async () => {
      const [sprzet, zapisana] = await Promise.all([LocalAuthentication.hasHardwareAsync(), LocalAuthentication.isEnrolledAsync()]);
      if (!sprzet || !zapisana) return undefined;
      const typy = await LocalAuthentication.supportedAuthenticationTypesAsync();
      if (typy.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
        return { nazwa: Platform.OS === 'ios' ? 'Face ID' : 'rozpoznawanie twarzy', twarz: true };
      }
      return { nazwa: Platform.OS === 'ios' ? 'Touch ID' : 'odcisk palca', twarz: false };
    },

    odblokuj: async () => {
      // Zapasem jest kod telefonu (bez własnego PIN-u, WZORCE-MOBBIN.md 7, ekran 5).
      const wynik = await LocalAuthentication.authenticateAsync({ promptMessage: 'Odblokuj FaktWay', cancelLabel: 'Anuluj', disableDeviceFallback: false });
      return wynik.success;
    },

    wczytaj: (klucz) => ustawienia.wczytaj(klucz),
    zapisz: (klucz, wartosc) => ustawienia.zapisz(klucz, wartosc),
  };
}
