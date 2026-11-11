/**
 * Szkic wycofany (wpis `number_taken`, decyzje 2, 3, 9, 11): odmowa wysyłki
 * jak wyzwalacz `c_guard_ksef_retired_draft` i baner na karcie.
 *
 * Część barelu `./duplicate-decision` (plan usprawnień 3.7b). Spoza
 * `lib/ksef/duplicate-decision*.ts` importuj tylko z barelu `@/lib/ksef/duplicate-decision`.
 * CZYSTY moduł (komponenty klienckie i worker): bez bazy, KSeF, Node i `duplicate-verdict.ts`.
 */

import { formatWarsawDateTime } from '@/lib/format/warsaw-date';
import { SPECIAL_KIND_LABEL, specialKindOf } from '@/lib/invoices/ksef-send-policy';

import { decisionLabel, isRecord, programOf, str, trimmed } from './duplicate-decision-jsonb';
import { decisionOf, importedDecisionOf, retiredRow, type TakenRowFields } from './duplicate-decision-rows';
import { documentNumber, sqlText } from './duplicate-decision-sql-texts';
import { DUPLICATE_DECISION_TEXTS } from './duplicate-decision-texts';
import type { RetiredDraftView } from './duplicate-decision-types';

// ─── Szkic wycofany (wpis `number_taken`, decyzje 2, 3, 9, 11) ───────────────

/**
 * Odmowa wysyłki szkicu z wpisem `number_taken` — dowolny rodzaj, decyzja
 * albo automatyczny „numer zajęty”. Ten sam tekst co wyzwalacz
 * `c_guard_ksef_retired_draft` (2.1.4 krok 7). `null` — brak wpisu.
 * PR C (4.11): decyzja z zapisem oryginału (`importedInvoiceId`) —
 * `TRIGGER_SAME_IMPORTED` / `TRIGGER_OTHER_IMPORTED` z dawnym numerem.
 */
export function retiredDraftSendRefusal(invoiceNumber: string | null, submissions: readonly TakenRowFields[]): string | null {
  const row = retiredRow(submissions);
  if (!row) return null;
  const nr = documentNumber(invoiceNumber);
  const k = row.original_ksef_number;
  const imported = importedDecisionOf(row, invoiceNumber);
  if (imported && k != null) {
    return imported.other
      ? sqlText('TRIGGER_OTHER_IMPORTED', imported.nrOld, imported.nrOld, k)
      : sqlText('TRIGGER_SAME_IMPORTED', imported.nrOld, k, imported.nrOld);
  }
  const decision = decisionOf(row);
  if (decision && k != null) {
    return sqlText(decision.choice === 'same_sale' ? 'TRIGGER_SAME' : 'TRIGGER_OTHER', nr, k);
  }
  return sqlText('TRIGGER_AUTO', nr, k != null ? `fakturę ${k}` : 'inną fakturę Twojej firmy');
}

export interface RetiredDraftViewInput {
  invoiceNumber: string | null;
  /** `invoices.invoice_kind`: regular | correction | advance | final. */
  invoiceKind: string | null;
  /** Wszystkie wpisy faktury (filtr `number_taken` jest tutaj). */
  submissions: readonly TakenRowFields[];
  /** Rodzaj wstrzymany w środowisku (`ksef_resend_facts.kindHeld`). */
  kindHeld: boolean;
}

/**
 * Baner szkicu wycofanego — każdy rodzaj (decyzja 9); `null` bez wpisu
 * `number_taken`. Zwykła faktura: decyzja „ta sama” / „ta sama” przy
 * known-number / „inna” albo automatyczny „numer zajęty”; zaliczka
 * i dokumenty usuwalne (korekta, faktura rozliczeniowa) — tylko automat
 * (decyzja jest wyłącznie dla zwykłej faktury; wpis z decyzją przy innym
 * rodzaju to uszkodzone dane — tekst automatyczny rodzaju).
 * PR C (6.4): decyzja z zapisem oryginału — banery `FAKTFLOW.BANNER_*` z dawnym
 * numerem, odnośnik do K (`imported`), zdanie o korekcie dla nabywcy bez NIP
 * i VAT-UE; decyzja po oddaniu (`no-import`) — teksty PR B z programem „nieznanym”.
 */
export function retiredDraftView(input: RetiredDraftViewInput): RetiredDraftView | null {
  const row = retiredRow(input.submissions);
  if (!row) return null;
  const T = DUPLICATE_DECISION_TEXTS;
  const FF = T.FAKTFLOW;
  const nr = documentNumber(input.invoiceNumber);
  const k = row.original_ksef_number;
  const special = specialKindOf(input.invoiceKind);
  // Jak `WHEN` wyzwalacza usuwania: zwykła i zaliczka — nie; korekta i faktura rozliczeniowa — tak.
  const deletable = special === 'correction' || special === 'final';
  const imported = importedDecisionOf(row, input.invoiceNumber);
  const base = {
    title: T.BANNER_TITLE(nr),
    sendRefusal: retiredDraftSendRefusal(input.invoiceNumber, input.submissions),
    deletable,
    deleteRefusal: deletable
      ? null
      : imported && k != null
        ? sqlText('TRIGGER_DELETE_IMPORTED', imported.nrOld, k)
        : sqlText('TRIGGER_DELETE', nr, k != null ? `faktura ${k}` : 'inna faktura Twojej firmy'),
  };

  if (special === 'advance') {
    return { ...base, body: T.BANNER_AUTO_ADVANCE(nr, k), cta: { ...T.CTA_ADVANCE }, knownInvoice: null };
  }
  if (special === 'correction' || special === 'final') {
    const label = SPECIAL_KIND_LABEL[special];
    const body = input.kindHeld
      ? T.BANNER_AUTO_DELETABLE_HELD(nr, k, label.G, label.A)
      : T.BANNER_AUTO_DELETABLE(nr, k, label.G, label.A);
    return { ...base, body, cta: null, knownInvoice: null };
  }

  // PR C: zapis oryginału — numer dokumentu przeszedł na fakturę K z KSeF.
  if (imported && k != null) {
    const check = row.original_check as Record<string, unknown>;
    const summary = isRecord(check.summary) ? check.summary : {};
    const nrK = trimmed(summary.number) ?? imported.nrOld;
    const data = imported.at ? formatWarsawDateTime(imported.at) : '';
    const via = imported.via === 'operator' ? T.BANNER_VIA_OPERATOR : '';
    const label = decisionLabel(imported.offer, imported.other ? 'other_sale' : 'same_sale');
    const banner = label === 'record' ? FF.BANNER_RECORD : label === 'other_sale' ? FF.BANNER_OTHER : FF.BANNER_SAME;
    return {
      ...base,
      title: FF.BANNER_TITLE(imported.nrOld),
      body: banner(data, via, nrK, k)
        + (imported.correctionForPerson ? FF.CORRECTION_PERSON : '')
        + (imported.correctionForRate ? FF.CORRECTION_RATE(nrK) : ''),
      // Jedyny przycisk tylko przy „inna sprzedaż” (C2).
      cta: label === 'other_sale' ? { ...T.CTA_REGULAR } : null,
      knownInvoice: null,
      imported: { id: imported.importedInvoiceId, internalNumber: imported.nrOld },
    };
  }

  const decision = k != null ? decisionOf(row) : null;
  if (decision && k != null) {
    const check = row.original_check as Record<string, unknown>;
    const data = decision.at ? formatWarsawDateTime(decision.at) : '';
    const via = decision.via === 'operator' ? T.BANNER_VIA_OPERATOR : '';
    const summary = isRecord(check.summary) ? check.summary : {};
    const nrK = trimmed(summary.number) ?? nr;
    // PR C: decyzja po oddaniu (`no-import`) — plik nie powstał w FaktWay: teksty PR B z programem „nieznanym”, bez K.
    const faktflow = check.reason === 'faktflow-original' || decision.mode !== null;
    const extra = faktflow ? { imported: null } : {};
    if (decision.choice === 'other_sale') {
      return { ...base, body: T.BANNER_OTHER(data, via, k, nr), cta: { ...T.CTA_REGULAR }, knownInvoice: null, ...extra };
    }
    const knownRaw = check.reason === 'known-number' && isRecord(check.knownInvoice) ? check.knownInvoice : null;
    const knownId = knownRaw ? str(knownRaw.id) : null;
    if (knownRaw && knownId) {
      const internalNumber = str(knownRaw.internalNumber);
      return {
        ...base,
        body: T.BANNER_SAME_KNOWN(data, via, nrK, k, internalNumber ?? 'bez numeru'),
        cta: null,
        knownInvoice: { id: knownId, internalNumber },
      };
    }
    const program = faktflow ? null : programOf(summary);
    return { ...base, body: T.BANNER_SAME(data, via, nrK, k, program), cta: null, knownInvoice: null, ...extra };
  }
  return { ...base, body: T.BANNER_AUTO(nr, k), cta: { ...T.CTA_REGULAR }, knownInvoice: null };
}
