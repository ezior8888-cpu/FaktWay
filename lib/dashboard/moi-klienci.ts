/**
 * „Moi klienci” (krok 6.2 planu kompletnej aplikacji, część 2): firmy, do
 * których użytkownik ma dostęp, z najważniejszymi sprawami każdej z nich.
 *
 * DANE Z JEDNEJ FUNKCJI BAZY. Polityki RLS pokazują dane tylko aktywnej firmy
 * (nagłówek `x-active-org`, `get_current_tenant_id()`), więc lista wielu firm
 * przez RLS to kilka zapytań na każdą firmę z osobnym klientem. Funkcja
 * `my_organizations_summary` (00185, SECURITY DEFINER) bierze firmy tylko
 * z aktywnych członkostw zalogowanego i oddaje same liczby, z warunkami tymi
 * samymi co `getReceivables` i kafel „Do opisania”. Szczegóły w migracji.
 *
 * W APLIKACJI zostaje to, co ma jedno źródło w kodzie:
 * - status KSeF z dowodu w środowisku aplikacji (`hasConfiguredKsefProof`,
 *   jak Ustawienia, KSeF) i z daty ważności certyfikatu (jak harmonogram
 *   skrzynki z 00160);
 * - najbliższy termin podatku albo ZUS z kalendarza modułu (`terminDla`),
 *   tylko dla firmy z włączonym modułem: te same trzy warstwy wyłącznika co
 *   `czyKsiegowoscWlaczona` (obszar `terminy`), VAT tylko płatnikowi VAT przy
 *   obszarze `vat` puszczonym w kodzie (jak przypomnienia K5). Globalny stop
 *   czytany rozstrzygająco (`getGlobalFlagForExecution`): „nie wiem” to nie
 *   „nie ma stopu”;
 * - link w menu tylko dla księgowej w co najmniej dwóch firmach.
 *
 * Kwoty w groszach (liczby całkowite z bazy), bez działań na ułamkach.
 */

import { shiftMonth } from '@/lib/expenses/month';
import { getGlobalFlagForExecution } from '@/lib/feature-flags/global-flags';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { isSubjectiveVatExemption } from '@/lib/invoices/vat-exemption';
import { hasConfiguredKsefProof, requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { terminDla, type RodzajTerminu } from '@/lib/ksiegowosc/kalendarz';
import { rozstrzygnij, statusObszaru } from '@/lib/ksiegowosc/wylacznik';
import type { UserRole } from '@/lib/supabase/auth-context';

/** Funkcja bazy z 00185. */
export const MOI_KLIENCI_RPC = 'my_organizations_summary';

/**
 * Od tylu firm z rolą księgowej menu pokazuje „Moi klienci” (opis wyboru
 * w PR kroku 6.2, część 2). Właściciel kilku własnych firm przełącza je
 * w „Moje firmy”; ekran i tak pokazuje każdemu tylko jego firmy.
 */
export const MIN_FIRM_Z_ROLA_KSIEGOWEJ = 2;

export function pokazMoichKlientow(czlonkostwa: readonly { role: string }[]): boolean {
  return czlonkostwa.filter((c) => c.role === 'accountant').length >= MIN_FIRM_Z_ROLA_KSIEGOWEJ;
}

/** Te same nazwy ról co w menu „Moje firmy”. */
export const ETYKIETY_ROL: Readonly<Record<UserRole, string>> = {
  owner: 'właściciel',
  admin: 'admin',
  member: 'członek',
  accountant: 'księgowy',
};

export interface NajblizszyTermin {
  /** Termin faktyczny (po przesunięciu na dzień roboczy), RRRR-MM-DD. */
  data: string;
  /** Rozliczenia z tym dniem terminu. */
  rodzaje: RodzajTerminu[];
}

/**
 * ZUS i podatek dochodowy obu form: forma opodatkowania nie jest tu
 * potrzebna, bo ryczałt i zaliczka PIT mają ten sam dzień, a gdyby kiedyś
 * miały różne, wygrywa wcześniejszy (lepiej za wcześnie niż za późno).
 */
const RODZAJE_BEZ_VAT: readonly RodzajTerminu[] = ['zus', 'ryczalt', 'zaliczkaPit'];

/**
 * Najbliższy termin od dziś (dzień terminu też się liczy). Termin za okres
 * wypada w miesiącu po nim, więc wystarczą okresy: poprzedni miesiąc (termin
 * w tym) i bieżący (termin w następnym). Bez danych kalendarza `null`.
 */
export function najblizszyTermin(dzis: string, opcje: { vat: boolean }): NajblizszyTermin | null {
  const rodzaje: readonly RodzajTerminu[] = opcje.vat ? [...RODZAJE_BEZ_VAT, 'vatJpk'] : RODZAJE_BEZ_VAT;
  const biezacy = dzis.slice(0, 7);
  let wynik: NajblizszyTermin | null = null;
  for (const okres of [shiftMonth(biezacy, -1), biezacy]) {
    const rok = Number(okres.slice(0, 4));
    const miesiac = Number(okres.slice(5, 7));
    for (const rodzaj of rodzaje) {
      const termin = terminDla({ rodzaj, rok, miesiac });
      if (!termin || termin.faktyczny < dzis) continue;
      if (!wynik || termin.faktyczny < wynik.data) wynik = { data: termin.faktyczny, rodzaje: [rodzaj] };
      else if (termin.faktyczny === wynik.data && !wynik.rodzaje.includes(rodzaj)) wynik.rodzaje.push(rodzaj);
    }
  }
  return wynik;
}

const NAZWY_TERMINU: Readonly<Record<RodzajTerminu, readonly string[]>> = {
  zus: ['ZUS'],
  ryczalt: ['podatek dochodowy'],
  zaliczkaPit: ['podatek dochodowy'],
  vatJpk: ['VAT', 'JPK_V7M'],
};

/** „ZUS i podatek dochodowy”, „VAT i JPK_V7M”. */
export function opisTerminu(rodzaje: readonly RodzajTerminu[]): string {
  const nazwy = [...new Set(rodzaje.flatMap((r) => NAZWY_TERMINU[r]))];
  if (nazwy.length <= 1) return nazwy[0] ?? '';
  return `${nazwy.slice(0, -1).join(', ')} i ${nazwy[nazwy.length - 1]}`;
}

export type StatusKsef = 'polaczono' | 'certyfikat_wygasl' | 'wymaga_potwierdzenia' | 'brak';

interface DaneKsef {
  has_ksef_credentials: boolean;
  ksef_verified_at: string | null;
  ksef_verified_environment: string | null;
  ksef_certificate_expiry: string | null;
}

/**
 * Te same warunki co plakietka w Ustawieniach, KSeF: certyfikat i dowód
 * w środowisku aplikacji to połączenie, certyfikat bez dowodu wymaga
 * potwierdzenia. Do tego wygasły certyfikat, który niczego nie pobierze.
 */
export function statusKsef(t: DaneKsef, teraz: Date): StatusKsef {
  if (!t.has_ksef_credentials) return 'brak';
  if (!hasConfiguredKsefProof(t.ksef_verified_at, t.ksef_verified_environment)) return 'wymaga_potwierdzenia';
  const wygasa = t.ksef_certificate_expiry ? Date.parse(t.ksef_certificate_expiry) : Number.NaN;
  return Number.isFinite(wygasa) && wygasa < teraz.getTime() ? 'certyfikat_wygasl' : 'polaczono';
}

export type PoTerminie =
  | { stan: 'ok'; liczba: number; sumaGr: number; walutaObca: number }
  /** Przyjęte faktury bez środowiska KSeF: `getReceivables` też wtedy nie pokazuje kwot. */
  | { stan: 'srodowisko' };

export type TerminFirmy =
  | ({ stan: 'ok' } & NajblizszyTermin)
  /** Kalendarz modułu nie zna terminów na ten dzień. */
  | { stan: 'brak' }
  /** Nie udało się sprawdzić globalnego stopu modułu. */
  | { stan: 'nieznany' };

export interface FirmaKlienta {
  organizationId: string;
  nazwa: string;
  nip: string;
  rola: UserRole;
  /** Firma otwarta teraz. */
  aktywna: boolean;
  kosztyDoOpisania: number;
  poTerminie: PoTerminie;
  ksef: StatusKsef;
  /** `null`: moduł księgowości dla tej firmy wyłączony, więc terminu nie ma na ekranie. */
  termin: TerminFirmy | null;
}

export type WynikMoichKlientow = { ok: true; firmy: FirmaKlienta[] } | { ok: false };

/** Wiersz funkcji bazy (00185). */
interface WierszBazy extends DaneKsef {
  organization_id: string;
  name: string;
  nip: string;
  role: UserRole;
  expenses_to_review: number;
  overdue_count: number;
  overdue_grosze: number;
  overdue_foreign_count: number;
  unknown_environment_count: number;
  vat_exemption_basis: string | null;
  ksiegowosc_enabled: boolean;
}

/** Typy funkcji z 00185 są lokalne, dopóki `types/database.ts` nie wygeneruje się z produkcji. */
export interface KlientRpc {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

const ROLE: ReadonlySet<string> = new Set(Object.keys(ETYKIETY_ROL));
const LICZNIKI = ['expenses_to_review', 'overdue_count', 'overdue_grosze', 'overdue_foreign_count', 'unknown_environment_count'] as const;
const TEKSTY_LUB_NULL = ['ksef_verified_at', 'ksef_verified_environment', 'ksef_certificate_expiry', 'vat_exemption_basis'] as const;

/** Wiersz w kształcie z migracji albo `null`: zły wiersz to błąd, nie zero. */
function zWiersza(w: unknown): WierszBazy | null {
  if (typeof w !== 'object' || w === null || Array.isArray(w)) return null;
  const r = w as Record<string, unknown>;
  if (typeof r.organization_id !== 'string' || typeof r.name !== 'string' || typeof r.nip !== 'string') return null;
  if (typeof r.role !== 'string' || !ROLE.has(r.role)) return null;
  if (LICZNIKI.some((k) => !(typeof r[k] === 'number' && Number.isSafeInteger(r[k]) && (r[k] as number) >= 0))) return null;
  if (TEKSTY_LUB_NULL.some((k) => r[k] !== null && typeof r[k] !== 'string')) return null;
  if (typeof r.has_ksef_credentials !== 'boolean' || typeof r.ksiegowosc_enabled !== 'boolean') return null;
  return r as unknown as WierszBazy;
}

/**
 * Terminy z kalendarza modułu dla firm z flagą modułu. Kolejność warstw jak
 * w `czyKsiegowoscWlaczona`: blokada w kodzie, globalny stop, flaga firmy.
 * Globalny stop czyta się raz na ekran i tylko wtedy, gdy jakaś firma ma flagę.
 */
async function terminyModulu(
  wiersze: readonly WierszBazy[],
  dzis: string,
  czytajGlobalnyStop: () => Promise<boolean>,
): Promise<Map<string, TerminFirmy>> {
  const wynik = new Map<string, TerminFirmy>();
  const kod = statusObszaru('terminy');
  const zFlaga = wiersze.filter((w) => w.ksiegowosc_enabled);
  if (!kod.wlaczony || zFlaga.length === 0) return wynik;

  let globalnyStop: boolean;
  try {
    globalnyStop = await czytajGlobalnyStop();
  } catch (e) {
    console.error('[moi-klienci] wyłącznik księgowości:', e instanceof Error ? e.message : e);
    for (const w of zFlaga) wynik.set(w.organization_id, { stan: 'nieznany' });
    return wynik;
  }

  const vatWKodzie = statusObszaru('vat').wlaczony;
  for (const w of zFlaga) {
    if (!rozstrzygnij({ globalnyStop, kod, firmaWlaczona: w.ksiegowosc_enabled }).wlaczony) continue;
    const termin = najblizszyTermin(dzis, { vat: vatWKodzie && !isSubjectiveVatExemption(w.vat_exemption_basis) });
    wynik.set(w.organization_id, termin ? { stan: 'ok', ...termin } : { stan: 'brak' });
  }
  return wynik;
}

export interface OpcjeMoichKlientow {
  /** Firma otwarta teraz (`getPageContext().tenantId`). */
  aktywnaFirma: string | null;
  teraz?: Date;
  /** Wstrzykiwany tylko w testach; produkcyjnie rozstrzygający odczyt `killKsiegowosc`. */
  czytajGlobalnyStop?: () => Promise<boolean>;
}

/**
 * Podsumowanie firm zalogowanego. Klient z sesji (bez klucza serwisowego):
 * funkcja bazy bierze firmy z `auth.uid()`. Błąd odczytu to `{ ok: false }`,
 * nigdy pusta lista ani zera.
 */
export async function czytajMoichKlientow(client: KlientRpc, opcje: OpcjeMoichKlientow): Promise<WynikMoichKlientow> {
  const teraz = opcje.teraz ?? new Date();
  let wiersze: WierszBazy[];
  try {
    const { data, error } = await client.rpc(MOI_KLIENCI_RPC, { p_ksef_environment: requireConfiguredKsefEnvironment() });
    if (error) throw new Error(error.message);
    if (!Array.isArray(data)) throw new Error('odpowiedź funkcji nie jest listą');
    const sprawdzone = data.map(zWiersza);
    if (sprawdzone.some((w) => w === null)) throw new Error('wiersz poza kształtem z 00185');
    wiersze = sprawdzone as WierszBazy[];
  } catch (e) {
    console.error('[moi-klienci] podsumowanie firm:', e instanceof Error ? e.message : e);
    return { ok: false };
  }

  const terminy = await terminyModulu(
    wiersze,
    todayInWarsaw(teraz),
    opcje.czytajGlobalnyStop ?? (() => getGlobalFlagForExecution('killKsiegowosc')),
  );

  const firmy = wiersze.map((w): FirmaKlienta => ({
    organizationId: w.organization_id,
    nazwa: w.name,
    nip: w.nip,
    rola: w.role,
    aktywna: w.organization_id === opcje.aktywnaFirma,
    kosztyDoOpisania: w.expenses_to_review,
    poTerminie:
      w.unknown_environment_count > 0
        ? { stan: 'srodowisko' }
        : { stan: 'ok', liczba: w.overdue_count, sumaGr: w.overdue_grosze, walutaObca: w.overdue_foreign_count },
    ksef: statusKsef(w, teraz),
    termin: terminy.get(w.organization_id) ?? null,
  }));
  firmy.sort(
    (a, b) =>
      a.nazwa.localeCompare(b.nazwa, 'pl') || a.nip.localeCompare(b.nip) || a.organizationId.localeCompare(b.organizationId),
  );
  return { ok: true, firmy };
}
