/**
 * Typy dla KSeF API 2.0 (wersja 2.2.1)
 * Dokumentacja: https://api-test.ksef.mf.gov.pl/docs/v2/
 *
 * Definiujemy TYLKO endpointy, których realnie używamy w MVP.
 * Gdy potrzebujesz nowego - dopisz go tutaj zamiast generować cały OpenAPI.
 */

// ═══════════════════════════════════════════════════════════════
// WSPÓLNE
// ═══════════════════════════════════════════════════════════════

export type KsefEnvironment = 'test' | 'demo' | 'production';

/**
 * Odpowiedź błędu KSeF w jednym z dwóch kształtów (`open-api.json` MF):
 * `application/problem+json` z `errors[]` albo starszy `exception` z listą
 * `exceptionDetailList` W ŚRODKU. Wszystkie pola opcjonalne — to sparsowany
 * JSON z zewnątrz; kody odczytuj przez `ksefErrorCodes` (`lib/ksef/client.ts`).
 */
export interface KsefErrorResponse {
  /** problem+json */
  title?: string;
  status?: number;
  errors?: Array<{
    code?: number;
    description?: string;
  }>;
  /** Starszy kształt. */
  exception?: {
    serviceCtx?: string;
    serviceCode?: string;
    serviceName?: string;
    exceptionDetailList?: Array<{
      exceptionCode?: number;
      exceptionDescription?: string;
    }>;
  };
}

// ═══════════════════════════════════════════════════════════════
// AUTENTYKACJA: POST /auth/challenge
// ═══════════════════════════════════════════════════════════════

export interface AuthChallengeResponse {
  /** Wyzwanie do podpisania - unikalny string */
  challenge: string;
  /** Timestamp wygenerowania challenge (ISO 8601) */
  timestamp: string;
  /** Timestamp w milisekundach od 1970-01-01 */
  timestampMs: number;
  /** IP klienta widziane przez KSeF (użyj do AuthorizationPolicy) */
  clientIp: string;
}

// ═══════════════════════════════════════════════════════════════
// AUTENTYKACJA: POST /auth/xades-signature
// Wysyłka podpisanego XML-a uwierzytelniającego
// ═══════════════════════════════════════════════════════════════

export interface AuthTokenResponse {
  /** Numer referencyjny żądania uwierzytelniania (do sprawdzania statusu) */
  referenceNumber: string;
  /** Tymczasowy token do pobrania accessToken */
  authenticationToken: {
    token: string;
    validUntil: string;
  };
}

// ═══════════════════════════════════════════════════════════════
// AUTENTYKACJA: POST /auth/token/redeem
// Wymiana authenticationToken na accessToken
// ═══════════════════════════════════════════════════════════════

export interface AccessTokenResponse {
  accessToken: {
    token: string;
    validUntil: string;
  };
  refreshToken: {
    token: string;
    validUntil: string;
  };
}

// ═══════════════════════════════════════════════════════════════
// AUTENTYKACJA: GET /auth/{referenceNumber}
// Status żądania uwierzytelniania
// ═══════════════════════════════════════════════════════════════

export interface AuthStatusResponse {
  /** Dawny kształt. Aktualny KSeF 2.0 nie zwraca tokenu w statusie: bierzemy go z odpowiedzi na wysłanie podpisu. */
  authenticationToken?: {
    token: string;
    validUntil: string;
  };
  status: {
    code: number;
    description: string;
    /** Np. „Certyfikat odwołany” przy kodzie 460 (dokumentacja MF, tabela statusów). */
    details?: string[] | null;
  };
}

// ═══════════════════════════════════════════════════════════════
// SESJE: POST /sessions/online
// Otwarcie sesji interaktywnej
// ═══════════════════════════════════════════════════════════════

export interface OpenOnlineSessionRequest {
  formCode: {
    systemCode: 'FA (3)';
    schemaVersion: '1-0E';
    value: 'FA';
  };
  encryption: {
    encryptedSymmetricKey: string; // Base64: klucz AES zaszyfrowany RSA-OAEP
    initializationVector: string; // Base64
  };
}

export interface OpenOnlineSessionResponse {
  /** Numer referencyjny sesji - używamy w kolejnych wywołaniach */
  referenceNumber: string;
}

// ═══════════════════════════════════════════════════════════════
// SESJE: POST /sessions/online/{referenceNumber}/invoices
// Wysłanie faktury
// ═══════════════════════════════════════════════════════════════

/**
 * Payload dla POST /sessions/online/{ref}/invoices w KSeF 2.0.
 * Źródło schemy: https://github.com/CIRFMF/ksef-docs/blob/main/sesja-interaktywna.md
 *
 * KSeF wymaga hash + size dla BYTES dwóch wariantów dokumentu:
 *   (a) oryginalny XML (niezaszyfrowany UTF-8) - do weryfikacji po dekryptacji
 *   (b) zaszyfrowane body (raw bytes PRZED Base64) - do weryfikacji transportu
 *
 * `encryptedInvoiceContent` to base64 szyfrogramu AES-256-CBC (bez IV w prefixie -
 * IV jest przekazywany osobno przy otwarciu sesji).
 */
export interface SendInvoiceRequest {
  /** SHA-256 hash oryginalnego XML (niezaszyfrowanego), Base64. */
  invoiceHash: string;
  /** Rozmiar oryginalnego XML w bajtach UTF-8. */
  invoiceSize: number;
  /** SHA-256 hash zaszyfrowanego body (bytes przed Base64), Base64. */
  encryptedInvoiceHash: string;
  /** Rozmiar zaszyfrowanego body w bajtach (przed Base64). */
  encryptedInvoiceSize: number;
  /** Zaszyfrowana treść XML FA(3) (AES-256-CBC + PKCS#7), Base64. */
  encryptedInvoiceContent: string;
}

export interface SendInvoiceResponse {
  /** Numer referencyjny faktury w ramach sesji */
  referenceNumber: string;
}

// ═══════════════════════════════════════════════════════════════
// SESJE: GET /sessions/{referenceNumber}/invoices/{invoiceRef}
// Status wysyłki konkretnej faktury
// ═══════════════════════════════════════════════════════════════

export interface InvoiceStatusResponse {
  referenceNumber: string;
  /** Przypisany numer KSeF po akceptacji */
  ksefNumber?: string;
  invoiceHash: string;
  status: {
    code: number;
    description: string;
    details?: string[];
    /**
     * Od API 2.0.0 RC6.0 przy kodzie 440 („Duplikat faktury”): numer KSeF
     * i sesja faktury, która JUŻ jest w systemie (CIRFMF/ksef-docs,
     * api-changelog.md).
     */
    extensions?: {
      originalKsefNumber?: string;
      originalSessionReferenceNumber?: string;
    };
  };
  /** Data akceptacji faktury przez KSeF */
  acquisitionTimestamp?: string;
  /** URL do pobrania UPO (Urzędowego Poświadczenia Odbioru) */
  upoDownloadUrl?: string;
}

// ═══════════════════════════════════════════════════════════════
// SESJE: GET /sessions/{referenceNumber}/invoices
// Faktury przesłane w sesji (open-api.json MF: SessionInvoicesResponse)
// ═══════════════════════════════════════════════════════════════

export interface SessionInvoicesResponse {
  /** Pusty albo brak — nie ma kolejnych stron. */
  continuationToken?: string | null;
  invoices: Array<{
    ordinalNumber: number;
    /** Numer faktury sprzedawcy (P_2). */
    invoiceNumber?: string | null;
    ksefNumber?: string | null;
    /** Numer referencyjny faktury w sesji. */
    referenceNumber: string;
    /** SHA-256 niezaszyfrowanego XML, Base64. */
    invoiceHash: string;
    status: InvoiceStatusResponse['status'];
  }>;
}

// Kody statusów faktury (patrz dokumentacja MF)
export const INVOICE_STATUS = {
  QUEUED: 150, // W trakcie przetwarzania
  ACCEPTED: 200, // Zaakceptowana
  REJECTED: 400, // Odrzucona
} as const;

// ═══════════════════════════════════════════════════════════════
// SESJE: POST /sessions/online/{referenceNumber}/close
// Zamknięcie sesji
// ═══════════════════════════════════════════════════════════════

// Zwraca 200 bez body w sukcesie

// ═══════════════════════════════════════════════════════════════
// CERTYFIKATY: GET /security/public-key-certificates
// Publiczne klucze MF (do szyfrowania)
// ═══════════════════════════════════════════════════════════════

/**
 * Użycie certyfikatu klucza publicznego MF.
 * Cert może mieć wiele usage (KSeF zwraca tablicę).
 */
export type PublicKeyCertificateUsage = 'KsefTokenEncryption' | 'SymmetricKeyEncryption';

export interface PublicKeyCertificate {
  /** Certyfikat X.509 w formacie DER, zakodowany Base64 (BEZ nagłówków PEM) */
  certificate: string;
  /** Lista zastosowań, do których można użyć certyfikatu */
  usage: PublicKeyCertificateUsage[];
  validFrom: string;
  validTo: string;
}

/** Odpowiedź z GET /security/public-key-certificates to tablica. */
export type PublicKeyCertificatesResponse = PublicKeyCertificate[];

// ═══════════════════════════════════════════════════════════════
// POBIERANIE FAKTUR: POST /invoices/query/metadata
// Wyszukanie otrzymanych faktur
// ═══════════════════════════════════════════════════════════════

/**
 * Kryterium filtrowania po dacie w query metadata.
 *
 * KSeF 2.0 akceptuje TYLKO dwa pola:
 *   - `Invoicing` - data wystawienia (`P_1` z FA(3))
 *   - `Issue`     - data wystawienia (alias `Invoicing`, API honoruje oba)
 *
 * UWAGA: KSeF 2.0 **nie** udostępnia filtru po dacie nadania/akceptacji
 * (`Acquisition`), mimo że to pole występuje w response (`acquisitionDate`).
 * Polling skrzynki musi używać `Invoicing` i akceptować opóźnienie między
 * wystawieniem a wpłynięciem (zwykle sekundy, w wyjątkach godziny).
 */
/** `PermanentStorage` — jedyna data do pobierania przyrostowego (MF, AUD-18). */
export type InvoiceQueryDateType = 'Invoicing' | 'Issue' | 'PermanentStorage';

export interface QueryInvoicesRequest {
  /** `subject1` = sprzedawca, `subject2` = nabywca. */
  subjectType: 'subject1' | 'subject2';
  dateRange: {
    dateType: InvoiceQueryDateType;
    from: string;
    to: string;
    /** Tylko dla `PermanentStorage`: `to` nie wyjdzie poza HWM. */
    restrictToPermanentStorageHwmDate?: boolean;
  };
  /** Numer KSeF faktury (dokładne dopasowanie). */
  ksefNumber?: string;
}

/**
 * Pojedynczy wiersz odpowiedzi `/invoices/query/metadata` (KSeF 2.0).
 *
 * Zweryfikowane przez bezpośrednie wywołanie API test-ksef (04/2026):
 *   - `seller` ma płaski `{ nip, name }` (zakładamy polski NIP sprzedawcy).
 *   - `buyer` ma `{ identifier: { type, value }, name }` (wspiera NIP/VatUe/Other).
 *   - `formCode` jest OBIEKTEM (w v1 był stringiem) - trzyma tryplet systemu FA(3).
 *   - `acquisitionDate` (nie `acquisitionTimestamp` z v1).
 *   - `grossAmount`/`netAmount`/`vatAmount` (nie `gross`).
 */
export interface InvoiceMetadata {
  ksefNumber: string;
  invoiceNumber: string;
  issueDate: string;
  /** ISO 8601 z timezone, np. `2026-04-02T10:25:49.746565+00:00`. */
  invoicingDate: string;
  acquisitionDate: string;
  permanentStorageDate: string;
  invoicingMode: 'Online' | 'Offline' | 'Offline24';
  invoiceType: 'Vat' | 'VatCorrective' | 'VatSimplified' | string;
  seller: {
    nip: string;
    name: string;
  };
  buyer: {
    identifier: {
      type: 'Nip' | 'VatUe' | 'Other';
      value: string;
    };
    name: string;
  };
  netAmount: number;
  grossAmount: number;
  vatAmount: number;
  currency: string;
  invoiceHash: string;
  formCode: {
    systemCode: string;
    schemaVersion: string;
    value: string;
  };
  isSelfInvoicing: boolean;
  hasAttachment: boolean;
}

/**
 * Odpowiedź `/invoices/query/metadata` (OpenAPI KSeF 2.0). Strony przez
 * `pageOffset`/`pageSize` w adresie — ten endpoint NIE ma tokenu kontynuacji.
 */
export interface QueryInvoicesResponse {
  invoices: InvoiceMetadata[];
  hasMore: boolean;
  /** Osiągnięto limit 10 000 rekordów — trzeba zawęzić `dateRange`. */
  isTruncated: boolean;
  /** Tylko dla `PermanentStorage`: poniżej tej chwili dane są kompletne. */
  permanentStorageHwmDate?: string | null;
}
