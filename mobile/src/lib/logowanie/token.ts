/**
 * Sesja zapisana w telefonie bez sieci (etap M7, przegląd M5b): start bez
 * internetu z wygasłym tokenem dostępu ma pokazać dane z poprzedniego
 * otwarcia, a nie ekran logowania. Bez React Native: testy w
 * `tests/unit/mobile-sesja-offline.test.ts`.
 *
 * Supabase zostawia sesję w pęku kluczy, gdy odświeżenie padło na sieci
 * (`isAuthRetryableFetchError`), i usuwa ją, gdy serwer odrzucił token
 * odświeżania. Sesja w pęku kluczy znaczy więc: serwer jej jeszcze nie
 * odrzucił. Dane z bazy i tak wymagają ważnego tokenu, więc telefon bez sieci
 * pokazuje tylko to, co już ma w pamięci.
 */

/** Pola tokenu dostępu, których używa telefon (tylko ASCII: identyfikatory i poziom). */
export type DaneTokenu = { uzytkownik?: string; sesja?: string; poziom?: string; wygasa?: number };

function base64url(tekst: string): string {
  const b64 = tekst.replace(/-/g, '+').replace(/_/g, '/');
  return atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

/** Treść tokenu JWT bez sprawdzania podpisu (to robi serwer); śmieci dają `{}`. */
export function daneTokenu(token: string | null | undefined): DaneTokenu {
  const czesc = token?.split('.')[1];
  if (!czesc) return {};
  try {
    const p = JSON.parse(base64url(czesc)) as Record<string, unknown>;
    return {
      uzytkownik: typeof p.sub === 'string' ? p.sub : undefined,
      sesja: typeof p.session_id === 'string' ? p.session_id : undefined,
      poziom: typeof p.aal === 'string' ? p.aal : undefined,
      wygasa: typeof p.exp === 'number' ? p.exp : undefined,
    };
  } catch {
    return {};
  }
}

/** Użytkownik z sesji Supabase w kształcie, którego potrzebuje telefon. */
export type UzytkownikSesji = {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
  app_metadata?: { provider?: unknown } | null;
  factors?: { factor_type?: string; status?: string }[] | null;
};

export type SesjaZapisana = { access_token: string; refresh_token: string; user: UzytkownikSesji };

/** Sesja zapisana przez `supabase-js` (JSON w pęku kluczy) albo `undefined`. */
export function sesjaZTekstu(tekst: string | null | undefined): SesjaZapisana | undefined {
  if (!tekst) return undefined;
  try {
    const s = JSON.parse(tekst) as Partial<SesjaZapisana> | null;
    if (!s || typeof s.access_token !== 'string' || typeof s.refresh_token !== 'string') return undefined;
    if (!s.user || typeof s.user.id !== 'string') return undefined;
    return s as SesjaZapisana;
  } catch {
    return undefined;
  }
}

/** Konto ma zweryfikowany TOTP, a ta sesja nie przeszła kodu: bez kodu nie wpuszczamy, także bez sieci. */
export function wymagaKoduBezSieci(s: SesjaZapisana): boolean {
  const totp = (s.user.factors ?? []).some((f) => f.factor_type === 'totp' && f.status === 'verified');
  return totp && daneTokenu(s.access_token).poziom !== 'aal2';
}
