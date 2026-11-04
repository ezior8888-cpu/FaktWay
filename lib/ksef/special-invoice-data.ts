import type { Invoice } from '@/types/invoice';
import { InvoiceValidationError } from '@/lib/xml/fa3-generator';

/**
 * Korekta, zaliczka i rozliczenie mają w XML FA(3) własne bloki — np.
 * `DaneFaKorygowanej` (którą fakturę korygujemy), przyczynę korekty, stan
 * przed i po, rozliczane zaliczki. Tych danych NIE MA w `fa3_data`: jadą
 * wyłącznie w zdarzeniu pierwszej wysyłki (`correctionData`, `advanceData`,
 * `finalData`).
 *
 * Bez nich `submitInvoiceFullFlow` spada do generatora zwykłej faktury,
 * który wpisuje `RodzajFaktury=KOR` (ZAL, ROZ) z `fa3_data.type` i nic
 * więcej. Taki XML PRZECHODZI walidację XSD (te bloki są w schemacie
 * opcjonalne), więc do KSeF poszłaby korekta bez wskazania faktury
 * korygowanej — dokumentu w KSeF nie da się usunąć, tylko skorygować.
 *
 * Tak działały dwie ścieżki: ponowna wysyłka z kolejki Offline24 i przycisk
 * „Wyślij ponownie”. Obie odtwarzają fakturę z bazy, bez tych danych.
 *
 * Od A4b dane są też na wierszu: ZAL w `fa3_data.advanceEnvelope`, KOR i ROZ
 * w `special_data` (00137). Cron i operator (PR2a) oraz klient — „Wyślij
 * ponownie” od A4b PR2b — odtwarzają z nich zdarzenie
 * (`lib/invoices/ksef-requeue-event.ts`). Ponowna wysyłka z kolejki Offline24
 * zostaje tylko dla zwykłych faktur (dokument specjalny idzie do uzgodnienia).
 * Ten bezpiecznik zostaje bez zmian.
 */
const SPECIAL_TYPE_LABEL = {
  KOR: 'korekty',
  KOR_ZAL: 'korekty',
  KOR_ROZ: 'korekty',
  ZAL: 'faktury zaliczkowej',
  ROZ: 'faktury rozliczeniowej',
} as const satisfies Partial<Record<Invoice['type'], string>>;

type SpecialType = keyof typeof SPECIAL_TYPE_LABEL;

function isSpecialType(type: string | null | undefined): type is SpecialType {
  return type != null && type in SPECIAL_TYPE_LABEL;
}

/** Komunikat dla użytkownika, gdy dokumentu nie da się wysłać z samej kopii. */
export function specialInvoiceResendMessage(type: string | null | undefined): string | null {
  if (!isSpecialType(type)) return null;
  return (
    `Brak danych ${SPECIAL_TYPE_LABEL[type]} potrzebnych do XML — z samej kopii faktury ` +
    'nie da się jej poprawnie wysłać do KSeF, a niepełnego dokumentu nie wysyłamy. ' +
    'Wystaw dokument ponownie z formularza.'
  );
}

export interface SpecialInvoiceData {
  correctionData?: unknown;
  advanceData?: unknown;
  finalPayload?: { advanceSettlementRows: readonly unknown[] } | null;
}

/**
 * Rzuca `InvoiceValidationError` (job kończy się bez ponowień, faktura
 * dostaje czytelny komunikat), gdy dokument specjalny nie ma swoich danych.
 */
export function assertSpecialInvoiceData(
  type: Invoice['type'] | null | undefined,
  data: SpecialInvoiceData,
): void {
  if (!isSpecialType(type)) return;

  const hasData =
    type === 'ZAL'
      ? data.advanceData != null
      : type === 'ROZ'
        ? data.finalPayload != null && data.finalPayload.advanceSettlementRows.length > 0
        : data.correctionData != null;

  if (!hasData) throw new InvoiceValidationError([specialInvoiceResendMessage(type)!]);
}
