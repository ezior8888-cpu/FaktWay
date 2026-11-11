// Klient API Białej Listy podatników VAT (Ministerstwo Finansów)
// Endpoint: https://wl-api.mf.gov.pl/api/search/nip/{nip}?date={YYYY-MM-DD}
// Dokumentacja: https://www.podatki.gov.pl/wykaz-podatnikow-vat-api/

import { todayInWarsaw } from '@/lib/format/warsaw-date';

const WHITELIST_API = 'https://wl-api.mf.gov.pl/api';
const TIMEOUT_MS = 8000;

export interface WhitelistResult {
  success: true;
  nip: string;
  legalName: string;
  vatStatus: 'active' | 'exempt' | 'inactive';
  registrationLegalDate?: string; // ISO YYYY-MM-DD
  registrationDenialDate?: string;
  restorationDate?: string;
  removalDate?: string;
  removalDenialDate?: string;
  registeredAddress?: string;
  workingAddress?: string;
  bankAccounts: string[]; // IBAN-y zgłoszone do US
  /** Firma ma w wykazie rachunki wirtualne (maski): rachunku spoza `bankAccounts` nie da się tu ocenić. */
  hasVirtualAccounts?: boolean;
  representatives?: Array<{
    firstName: string;
    lastName: string;
    companyName?: string;
  }>;
  authorizedClerks?: Array<{ firstName: string; lastName: string }>;
  partners?: Array<{
    firstName: string;
    lastName: string;
    companyName?: string;
  }>;
  rawResponse: unknown;
}

export interface WhitelistError {
  success: false;
  error: string;
  errorCode: 'NOT_FOUND' | 'INVALID_NIP' | 'API_ERROR' | 'TIMEOUT' | 'RATE_LIMIT';
}

export type WhitelistResponse = WhitelistResult | WhitelistError;

// ============================================================================
// MAIN: lookup NIP w Białej Liście
// ============================================================================

export async function checkNipInWhitelist(
  nip: string,
  date?: string // domyślnie dzisiaj
): Promise<WhitelistResponse> {
  const cleanNip = nip.replace(/[\s\-]/g, '');
  if (!/^\d{10}$/.test(cleanNip)) {
    return {
      success: false,
      error: 'NIP musi mieć 10 cyfr',
      errorCode: 'INVALID_NIP',
    };
  }

  // Dzień w Polsce (FZ-003): w UTC między 0:00 a 1:00/2:00 byłby wczorajszy.
  const checkDate = date ?? todayInWarsaw();
  const url = `${WHITELIST_API}/search/nip/${cleanNip}?date=${encodeURIComponent(checkDate)}`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'KSeF-SaaS/1.0',
      },
    });

    clearTimeout(timeoutId);

    if (response.status === 429) {
      return {
        success: false,
        error: 'Limit zapytań do Białej Listy przekroczony',
        errorCode: 'RATE_LIMIT',
      };
    }

    if (!response.ok) {
      return {
        success: false,
        error: `Biała Lista zwróciła ${response.status}`,
        errorCode: 'API_ERROR',
      };
    }

    const data: unknown = await response.json();
    const subject = getWhitelistSubject(data);

    if (!subject) {
      return {
        success: true,
        nip: cleanNip,
        legalName: 'Brak w Białej Liście VAT',
        vatStatus: 'inactive',
        bankAccounts: [],
        rawResponse: data,
      };
    }

    let vatStatus: 'active' | 'exempt' | 'inactive';
    const statusVat =
      typeof subject.statusVat === 'string'
        ? subject.statusVat.toLowerCase()
        : '';

    if (statusVat.includes('czynny')) {
      vatStatus = 'active';
    } else if (statusVat.includes('zwolniony')) {
      vatStatus = 'exempt';
    } else {
      vatStatus = 'inactive';
    }

    return {
      success: true,
      nip: cleanNip,
      legalName:
        typeof subject.name === 'string' ? subject.name : 'Nieznana nazwa',
      vatStatus,
      registrationLegalDate: optionalString(subject.registrationLegalDate),
      registrationDenialDate: optionalString(subject.registrationDenialDate),
      restorationDate: optionalString(subject.restorationDate),
      removalDate: optionalString(subject.removalDate),
      removalDenialDate: optionalString(subject.removalDenialDate),
      registeredAddress: optionalString(subject.residenceAddress),
      workingAddress: optionalString(subject.workingAddress),
      bankAccounts: stringArray(subject.accountNumbers),
      hasVirtualAccounts: subject.hasVirtualAccounts === true,
      representatives: subject.representatives,
      authorizedClerks: subject.authorizedClerks,
      partners: subject.partners,
      rawResponse: data,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown';

    if (
      message.includes('aborted') ||
      message.includes('timeout') ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      return {
        success: false,
        error: 'Biała Lista nie odpowiada (timeout)',
        errorCode: 'TIMEOUT',
      };
    }

    return {
      success: false,
      error: `Błąd połączenia: ${message}`,
      errorCode: 'API_ERROR',
    };
  }
}

// ============================================================================
// Sprawdzenie czy konkretny rachunek bankowy jest na Białej Liście
// ============================================================================

/**
 * Wynik sprawdzenia rachunku. Trzy stany, bo „nie udało się sprawdzić” to
 * nie „rachunku nie ma w wykazie” ani tym bardziej „rachunek w porządku”
 * (krok 3.4 planu kompletnej aplikacji, RP-BL-01):
 *  - `in_list`: rachunek jest w wykazie na `checkedOn`;
 *  - `not_in_list`: wykaz odpowiedział, a rachunku w nim nie ma (także gdy
 *    firmy w wykazie nie ma);
 *  - `unverified`: błąd API (limit, awaria, brak odpowiedzi, zły NIP) albo
 *    rachunek, który może być wirtualny (firma ma maski w wykazie).
 */
export type WhitelistAccountStatus = 'in_list' | 'not_in_list' | 'unverified';

/** Rachunek do porównania z wykazem: bez spacji, wielkie litery, polski IBAN bez „PL” (wykaz podaje 26 cyfr). */
export function normalizeWhitelistAccount(account: string): string {
  const clean = account.replace(/\s/g, '').toUpperCase();
  return /^PL\d{26}$/.test(clean) ? clean.slice(2) : clean;
}

export async function checkBankAccountInWhitelist(
  nip: string,
  bankAccount: string,
  date?: string
): Promise<{
  status: WhitelistAccountStatus;
  isOnWhitelist: boolean;
  legalName?: string;
  warning?: string;
  checkedOn?: string;
}> {
  const result = await checkNipInWhitelist(nip, date);

  if (!result.success) {
    return {
      status: 'unverified',
      isOnWhitelist: false,
      warning: result.error,
    };
  }

  const checkedOn = date ?? new Date().toISOString().slice(0, 10);
  const cleanAccount = normalizeWhitelistAccount(bankAccount);
  const isOnWhitelist = result.bankAccounts.some((a) => normalizeWhitelistAccount(a) === cleanAccount);

  if (!isOnWhitelist && result.hasVirtualAccounts) {
    return {
      status: 'unverified',
      isOnWhitelist: false,
      legalName: result.legalName,
      checkedOn,
      warning:
        'Firma ma w wykazie rachunki wirtualne, a tego rachunku nie ma wśród zwykłych. Sprawdź go w wyszukiwarce wykazu podatników VAT na podatki.gov.pl.',
    };
  }

  return {
    status: isOnWhitelist ? 'in_list' : 'not_in_list',
    isOnWhitelist,
    legalName: result.legalName,
    checkedOn,
    warning: !isOnWhitelist
      ? 'Rachunek bankowy nie jest zgłoszony do US: możesz stracić prawo do odliczenia VAT'
      : undefined,
  };
}

type WhitelistSubjectShape = {
  statusVat?: unknown;
  name?: unknown;
  registrationLegalDate?: unknown;
  registrationDenialDate?: unknown;
  restorationDate?: unknown;
  removalDate?: unknown;
  removalDenialDate?: unknown;
  residenceAddress?: unknown;
  workingAddress?: unknown;
  accountNumbers?: unknown;
  hasVirtualAccounts?: unknown;
  representatives?: WhitelistResult['representatives'];
  authorizedClerks?: WhitelistResult['authorizedClerks'];
  partners?: WhitelistResult['partners'];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getWhitelistSubject(data: unknown): WhitelistSubjectShape | null {
  if (!isRecord(data)) return null;
  const result = data.result;
  if (!isRecord(result)) return null;
  const subject = result.subject;
  if (!isRecord(subject)) return null;
  return subject as WhitelistSubjectShape;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === 'string');
}

// ============================================================================
// Metoda „check”: czy rachunek jest przypisany do NIP (plik przelewów)
// ============================================================================

/**
 * Wynik metody `check` API MF (krok 3.4, część 2, RP-BL-01): `assigned`
 * („TAK”) albo `not_assigned` („NIE”) zawsze z identyfikatorem zapytania
 * (`requestId`), który jest dowodem sprawdzenia. Każdy błąd, także odpowiedź
 * bez `requestId` albo z inną wartością niż TAK i NIE, to `error`: nigdy
 * „rachunek w porządku”.
 */
export type WhitelistAssignmentResult =
  | { status: 'assigned' | 'not_assigned'; requestId: string; requestDateTime: string | null }
  | { status: 'error'; error: string; errorCode: 'INVALID_INPUT' | 'API_ERROR' | 'TIMEOUT' | 'RATE_LIMIT' | 'BAD_RESPONSE' };

/**
 * `GET /api/check/nip/{nip}/bank-account/{rachunek}?date=RRRR-MM-DD`
 * (https://wl-api.mf.gov.pl/, EntityCheckResponse: `result.accountAssigned`,
 * `result.requestId`, `result.requestDateTime`; błąd 400: `{ code, message }`).
 * W odróżnieniu od `search/nip` odpowiada też dla rachunków wirtualnych.
 */
export async function checkBankAccountAssignment(
  nip: string,
  bankAccount: string,
  date: string,
): Promise<WhitelistAssignmentResult> {
  const cleanNip = nip.replace(/[\s-]/g, '');
  const cleanAccount = normalizeWhitelistAccount(bankAccount);
  if (!/^\d{10}$/.test(cleanNip) || !/^\d{26}$/.test(cleanAccount) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { status: 'error', error: 'NIP, rachunek albo data w złym formacie', errorCode: 'INVALID_INPUT' };
  }

  const url = `${WHITELIST_API}/check/nip/${cleanNip}/bank-account/${cleanAccount}?date=${encodeURIComponent(date)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'KSeF-SaaS/1.0' },
    });
    if (response.status === 429) {
      return { status: 'error', error: 'limit zapytań do wykazu przekroczony', errorCode: 'RATE_LIMIT' };
    }
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const code = isRecord(data) && typeof data.code === 'string' ? ` ${data.code}` : '';
      const message = isRecord(data) && typeof data.message === 'string' ? `: ${data.message}` : '';
      return { status: 'error', error: `wykaz odpowiedział błędem ${response.status}${code}${message}`, errorCode: 'API_ERROR' };
    }
    const result = isRecord(data) && isRecord(data.result) ? data.result : null;
    const assigned = result?.accountAssigned;
    const requestId = typeof result?.requestId === 'string' ? result.requestId.trim() : '';
    if ((assigned !== 'TAK' && assigned !== 'NIE') || !requestId) {
      return { status: 'error', error: 'odpowiedź wykazu bez wyniku albo bez numeru zapytania', errorCode: 'BAD_RESPONSE' };
    }
    return {
      status: assigned === 'TAK' ? 'assigned' : 'not_assigned',
      requestId,
      requestDateTime: optionalString(result?.requestDateTime) ?? null,
    };
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || /abort|timeout/i.test(error.message))) {
      return { status: 'error', error: 'wykaz nie odpowiada', errorCode: 'TIMEOUT' };
    }
    return { status: 'error', error: 'brak połączenia z wykazem', errorCode: 'API_ERROR' };
  } finally {
    clearTimeout(timeoutId);
  }
}
