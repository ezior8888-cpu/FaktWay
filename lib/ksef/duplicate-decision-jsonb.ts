/**
 * Polityka na surowym jsonb znacznika (lustra `ksef_duplicate_check_allows`,
 * `ksef_duplicate_own_history`, `ksef_duplicate_original_offer` i kroku 11c
 * blokady), warianty powiadomień i pochodzenie faktury K.
 *
 * Część barelu `./duplicate-decision` (plan usprawnień 3.7b). Spoza
 * `lib/ksef/duplicate-decision*.ts` importuj tylko z barelu `@/lib/ksef/duplicate-decision`.
 * CZYSTY moduł (komponenty klienckie i worker): bez bazy, KSeF, Node i `duplicate-verdict.ts`.
 */

import {
  DUPLICATE_ORIGINAL_IMPORT_OFFERS,
  ORIGINAL_IMPORT_SOURCE,
  originalGateOk,
  type DuplicateOriginalImportOffer,
  type DuplicateOriginalOffer,
} from './duplicate-check';
import type {
  DuplicateChoice,
  DuplicateDecisionLabel,
  DuplicateDecisionSubmissionRow,
  DuplicateNoticeVariant,
  ImportedOriginalProvenance,
} from './duplicate-decision-types';

/**
 * `<SystemInfo>` plików FaktWay — ta sama wartość co `FAKTFLOW_SYSTEM_INFO`
 * w `duplicate-verdict.ts` (tamten moduł ciągnie `node:crypto`, więc nie do
 * komponentu); generatory przypina `ksef-duplikat-werdykt.test.ts`.
 */
export const FAKTFLOW_SYSTEM_INFO = 'KSeF SaaS v1.0';

// ─── Polityka jsonb (lustro `ksef_duplicate_check_allows`, 2.1.1; 00156 4.2) ──

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const hasKey = (v: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(v, key);
export const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export const trimmed = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length > 0 ? s : null;
};

/** `FaktWay` dla pliku FaktWay, inaczej nazwa z `SystemInfo`; `null` — nieznany. */
export function programOf(summary: Record<string, unknown>): string | null {
  const systemInfo = str(summary.systemInfo);
  return systemInfo === FAKTFLOW_SYSTEM_INFO ? 'FaktWay' : systemInfo;
}

/**
 * `->>` z SQL dla skalara jsonb: napis bez zmian (także pusty), liczba i wartość
 * logiczna jako tekst; `null`, brak klucza, obiekt i tablica — `null` (tych
 * kluczy RPC nigdy nie zapisuje jako obiektów).
 */
export const jsonText = (v: unknown): string | null => {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
};

/** `archivePath` oryginału: `<firma (36 znaków)>/ksef-import/<numer KSeF>.xml` (4.2). */
const FAKTFLOW_ARCHIVE_PATH = /^[0-9a-f-]{36}\/ksef-import\/[A-Za-z0-9-]{1,64}\.xml$/;
/** Przyszła postać `<SystemInfo>` plików z naszego generatora (D-A4-1b-3-SYS) — wzorzec dosłownie jak w funkcji bazy 00156, w nazwie sprzed zmiany marki. */
const FAKTFLOW_SYSTEM_INFO_NEXT = /^FaktFlow [0-9]/;
/** `sizeBytes` jako tekst jsonb: liczba całkowita dodatnia, najwyżej 10 cyfr (potem ≤ int4). */
const SIZE_BYTES_TEXT = /^[1-9][0-9]{0,9}$/;

/** `SystemInfo` pliku z naszego generatora — dziś `KSeF SaaS v1.0`, w przyszłości `<nazwa> <wersja>` (wzorzec wyżej). */
const isFaktflowSystemInfo = (v: unknown): boolean =>
  typeof v === 'string' && (v === FAKTFLOW_SYSTEM_INFO || FAKTFLOW_SYSTEM_INFO_NEXT.test(v));

/**
 * Gałąź `faktflow-original` z 4.2 (00156): `ownHistory` logiczne, treść
 * logiczna / `null` / brak klucza, SystemInfo FaktWay, `archivePath`
 * i `sizeBytes` oryginału; `other_sale` tylko przy `ownHistory = false`
 * i treści różnej od `true` (część JSON reguły „tylko zapis” — część z bazy
 * rozstrzyga oferta, 4.4). `importGate` NIE wchodzi do `allows`.
 */
function faktflowCheckAllows(raw: Record<string, unknown>, summary: Record<string, unknown>, choice: DuplicateChoice | null): boolean {
  if (typeof raw.ownHistory !== 'boolean') return false;
  const content = raw.sameContentExceptHeader;
  if (content !== undefined && content !== null && typeof content !== 'boolean') return false;
  if (!isFaktflowSystemInfo(summary.systemInfo)) return false;
  if (typeof raw.archivePath !== 'string' || !FAKTFLOW_ARCHIVE_PATH.test(raw.archivePath)) return false;
  // CASE w SQL: rzut na bigint dopiero po sprawdzeniu tekstu liczby.
  if (typeof raw.sizeBytes !== 'number' || !SIZE_BYTES_TEXT.test(String(raw.sizeBytes)) || raw.sizeBytes > 2147483647) {
    return false;
  }
  return choice !== 'other_sale' || (raw.ownHistory === false && content !== true);
}

/**
 * Czy zapis sprawdzenia oryginału pozwala na decyzję klienta — na SUROWYM jsonb,
 * tak jak SQL (typy sprawdzane jawnie: `v:"1"`, liczbowe `knownInvoice.id`
 * odmawiają). `choice` null = dowolny wybór. `recheck` nie blokuje: dane
 * z wcześniejszego udanego sprawdzenia są ważne (faktura w KSeF się nie zmienia).
 * PR C (00156, 4.2): powód `faktflow-original` z własną gałęzią
 * (`faktflowCheckAllows`); gałąź powodów PR B bez zmian (INV-14).
 */
export function duplicateCheckAllows(raw: unknown, choice: DuplicateChoice | null): boolean {
  if (!isRecord(raw) || raw.v !== 1) return false;
  if (hasKey(raw, 'decision')) return false;
  if (choice !== null && choice !== 'same_sale' && choice !== 'other_sale') return false;
  if (raw.reason !== 'no-own-file' && raw.reason !== 'known-number' && raw.reason !== 'faktflow-original') return false;
  if (typeof raw.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(raw.sha256)) return false;
  if (!isRecord(raw.summary)) return false;
  if (raw.reason === 'faktflow-original') return faktflowCheckAllows(raw, raw.summary, choice);
  // NULL (nie wiadomo) odmawia; true = oryginał może być nasz.
  if (raw.ownHistory !== false) return false;
  if (raw.reason === 'known-number') {
    return isRecord(raw.knownInvoice) && typeof raw.knownInvoice.id === 'string' && raw.knownInvoice.id !== '';
  }
  return true;
}

// ─── PR C (00156): lustra oferty, bramy i znacznika „sprawdź ponownie” ───────

/**
 * Lustro kroku 11c blokady (`recheck-needed`, 4.5) na surowym jsonb znacznika
 * `faktflow-original`: `!originalGateOk(check.importGate) || check ? 'recheckNeeded'`.
 * Liczy się OBECNOŚĆ klucza `recheckNeeded` (M4: `recheckNeeded: null` też),
 * jak operator `?` w SQL. TS liczy go sam z JSON (R-C16 porównuje z SQL).
 */
export function originalRecheckNeeded(check: unknown): boolean {
  const gate = isRecord(check) ? check.importGate : undefined;
  return !originalGateOk(gate) || (isRecord(check) && hasKey(check, 'recheckNeeded'));
}

/**
 * Lustro `ksef_duplicate_own_history` (4.3) — predykat kroku 12 z 00148:
 * któraś próba faktury ma sesję oryginału (`marker.original_session_reference_number`)
 * albo `lower(request_payload_hash)` = SHA-256 oryginału (`marker.original_check.sha256`).
 * Brak sesji albo skrótu na znaczniku nie dopasowuje prób (NULL ≠ NULL).
 */
export function ownHistoryInSubmissions(
  submissions: ReadonlyArray<Pick<DuplicateDecisionSubmissionRow, 'session_reference_number' | 'request_payload_hash'>>,
  marker: Pick<DuplicateDecisionSubmissionRow, 'original_session_reference_number' | 'original_check'>,
): boolean {
  const session = marker.original_session_reference_number;
  const sha256 = isRecord(marker.original_check) ? jsonText(marker.original_check.sha256) : null;
  return submissions.some((s) =>
    (session != null && s.session_reference_number === session)
    || (sha256 !== null && s.request_payload_hash != null && s.request_payload_hash.toLowerCase() === sha256));
}

/**
 * Lustro `ksef_duplicate_original_offer` (4.4) — JEDNA funkcja oferty dla
 * panelu, powiadomień i operatora. `null` poza `faktflow-original` albo gdy
 * `duplicateCheckAllows(check, null)` odmawia. `ownHistoryDb` `null` =
 * nieznane = tylko zapis (fail-closed). Porównania `=== true` (NULL w
 * `sameContentExceptHeader` nie daje `record`).
 */
export function duplicateOriginalOffer(check: unknown, ownHistoryDb: boolean | null): DuplicateOriginalOffer | null {
  // 1. tylko faktflow-original, które przechodzi allows
  if (!isRecord(check) || check.reason !== 'faktflow-original' || !duplicateCheckAllows(check, null)) return null;
  // 2. „tylko zapis”: własna historia w JSON albo w bazie, ta sama treść; nieznana historia z bazy = tak
  const recordOnly = check.ownHistory === true || check.sameContentExceptHeader === true || (ownHistoryDb ?? true);
  // 3. brama
  const gate = check.importGate;
  const gateOk = originalGateOk(gate);
  const gateObj = isRecord(gate) ? gate : null;
  // 4. poprawna brama importable — zapis oryginału
  if (gateOk && gateObj?.kind === 'importable') return recordOnly ? 'record' : 'pair';
  // 5. poprawna brama review z oddaniem decyzji przez operatora i bez „tylko zapis”
  const release = gateObj && isRecord(gateObj.release) ? gateObj.release : null;
  if (gateOk && !recordOnly && release && typeof release.at === 'string' && release.via === 'operator') return 'released';
  // 6. review, brak bramy albo zły kształt — przegląd operatora
  return recordOnly ? 'review-record' : 'review-pair';
}

/**
 * Wariant e-maila, pusha i przypomnienia operatora (5.5, INV-24): `review` przy
 * blokadzie `provenance-review`; przy blokadzie NULL — `record` / `released` /
 * `pair` z `duplicateOriginalOffer` (powody PR B → `pair`); inna blokada →
 * `null`. `ownHistoryDb` bez `null` — wołający liczy historię
 * (`ownHistoryInSubmissions`) z tych samych kolumn co panel.
 */
export function duplicateNoticeVariant(check: unknown, ownHistoryDb: boolean, blocker: string | null): DuplicateNoticeVariant | null {
  if (blocker === 'provenance-review') return 'review';
  if (blocker !== null) return null;
  const offer = duplicateOriginalOffer(check, ownHistoryDb);
  if (offer === 'record' || offer === 'released' || offer === 'pair') return offer;
  // Przegląd przy blokadzie NULL (wyścig odczytów) — nigdy „czeka na Twoją decyzję”.
  if (offer !== null) return 'review';
  // Powody PR B (no-own-file, known-number) — powiadomienie PR B.
  return duplicateCheckAllows(check, null) ? 'pair' : null;
}

/** Etykieta decyzji (karta K, `ALREADY_IMPORTED`, toasty): oferta `record`/`review-record` → `record`, inaczej wybór. */
export function decisionLabel(offer: DuplicateOriginalOffer | null | undefined, choice: DuplicateChoice): DuplicateDecisionLabel {
  return offer === 'record' || offer === 'review-record' ? 'record' : choice;
}

/**
 * Pochodzenie faktury K (`fa3_data.import`, 6.5): tylko `source =
 * 'ksef_duplicate_decision'` (`ORIGINAL_IMPORT_SOURCE`) i poprawne `decision`
 * (wybór, oferta trybu import, `via`, data, X); inaczej `null`.
 */
export function importedOriginalProvenance(fa3Data: unknown): ImportedOriginalProvenance | null {
  if (!isRecord(fa3Data) || !isRecord(fa3Data.import)) return null;
  const imported = fa3Data.import;
  if (imported.source !== ORIGINAL_IMPORT_SOURCE || !isRecord(imported.decision)) return null;
  const { choice, offer, via, at, retiredInvoiceId, retiredInternalNumber } = imported.decision;
  if (choice !== 'same_sale' && choice !== 'other_sale') return null;
  if (typeof offer !== 'string' || !(DUPLICATE_ORIGINAL_IMPORT_OFFERS as readonly string[]).includes(offer)) return null;
  if (via !== 'client' && via !== 'operator') return null;
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return null;
  const retiredId = str(retiredInvoiceId);
  const retiredNumber = str(retiredInternalNumber);
  if (retiredId === null || retiredNumber === null) return null;
  return {
    decidedAt: at,
    choice,
    offer: offer as DuplicateOriginalImportOffer,
    via,
    retiredInvoiceId: retiredId,
    retiredInternalNumber: retiredNumber,
  };
}
