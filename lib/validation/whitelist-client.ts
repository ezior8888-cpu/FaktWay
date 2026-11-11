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

export async function checkBankAccountInWhitelist(
  nip: string,
  bankAccount: string,
  date?: string
): Promise<{
  isOnWhitelist: boolean;
  legalName?: string;
  warning?: string;
}> {
  const result = await checkNipInWhitelist(nip, date);

  if (!result.success) {
    return {
      isOnWhitelist: false,
      warning: result.error,
    };
  }

  const cleanAccount = bankAccount.replace(/\s/g, '').toUpperCase();
  const accountsNormalized = result.bankAccounts.map((a) =>
    a.replace(/\s/g, '').toUpperCase()
  );

  const isOnWhitelist = accountsNormalized.includes(cleanAccount);

  return {
    isOnWhitelist,
    legalName: result.legalName,
    warning: !isOnWhitelist
      ? 'Rachunek bankowy nie jest zgłoszony do US — możesz stracić prawo do odliczenia VAT'
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
