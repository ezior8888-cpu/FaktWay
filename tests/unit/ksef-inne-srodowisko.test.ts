import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { StatusBadge } from '@/components/invoices/status-badge';
import { OPERATOR_MESSAGES, operatorInvoiceButtons } from '@/lib/admin/ksef-operator-policy';
import type { KsefResendFacts } from '@/lib/invoices/ksef-requeue-event';
import {
  decideResend,
  failedInvoiceButtons,
  KSEF_SEND_MESSAGES,
  KSEF_SPECIAL_SEND_MESSAGES,
} from '@/lib/invoices/ksef-send-policy';
import { SEND_ERROR_CODES, sendErrorClassOf } from '@/lib/ksef/send-error-classes';
import { SUPPORT_EMAIL } from '@/lib/site';

/**
 * D-A4-2 (decyzja Bartosza 04.10.2026, plan „zero zgubionych faktur”):
 * `ENV_MISMATCH` — zdarzenie wysyłki z innego środowiska KSeF niż
 * skonfigurowane (np. faktura zlecona na TEST, worker już na PROD). Runner nie
 * dotknął KSeF, a ponowienie wysłałoby fakturę w BIEŻĄCYM środowisku — czyli
 * dokument testowy jako prawdziwy. Dlatego: powrót do szkicu i decyzja klienta
 * (wysłać tutaj albo nie wystawiać), nigdy „Wyślij ponownie”. Dziś kod jest
 * w klasie reconcile, więc `reset_ksef_send` odmawia, a klient nie ma żadnego
 * przycisku — ślepa uliczka.
 */
const CODE = SEND_ERROR_CODES.ENV_MISMATCH;
/** Fakty ponowienia operatora (A4b PR2a): zwykła faktura z danymi. */
const STORED: KsefResendFacts = { sendData: 'stored', kindHeld: false, issueDatePassed: false };
/** Faktura z błędem wysyłki ENV_MISMATCH — klient (od A4b PR2b) też dostaje fakty i `environmentKnown`. */
const FAILED = { status: 'failed', errorCode: CODE, facts: STORED, environmentKnown: true } as const;

describe('D-A4-2: ENV_MISMATCH — powrót do szkicu, decyzja klienta', () => {
  it('klasa terminal: jedyne wyjście to szkic (RPC odmawia ponowienia w bieżącym środowisku)', () => {
    expect(sendErrorClassOf(CODE)).toBe('terminal');
  });

  it('klient (właściciel): „Wróć do szkicu” bez „Wyślij ponownie”, z wyjaśnieniem zamiast „błędu treści”', () => {
    expect(failedInvoiceButtons({ ...FAILED, invoiceKind: 'regular', canManage: true })).toEqual({
      resend: false,
      reset: true,
      settings: false,
      info: KSEF_SEND_MESSAGES.envMismatch,
    });
    expect(KSEF_SEND_MESSAGES.envMismatch).toMatch(/środowisk/);
    expect(KSEF_SEND_MESSAGES.envMismatch).toMatch(/szkic/);
    // Ten sam tekst stoi przy fakturze z dowodem kontaktu (interfejs zna tylko
    // kod) — nie może twierdzić, że faktura nie dotarła do KSeF, i musi mówić,
    // co zrobić, gdy powrót do szkicu jest zablokowany.
    expect(KSEF_SEND_MESSAGES.envMismatch).not.toMatch(/nie została wysłana/);
    expect(KSEF_SEND_MESSAGES.envMismatch).toMatch(/nie wystawiaj/);
  });

  it('klient bez uprawnień: ten sam komunikat i prośba do właściciela', () => {
    const b = failedInvoiceButtons({ ...FAILED, invoiceKind: 'regular', canManage: false });
    expect(b).toMatchObject({ resend: false, reset: false });
    expect(b?.info).toBe(`${KSEF_SEND_MESSAGES.envMismatch} ${KSEF_SEND_MESSAGES.askManager}`);
  });

  it('korekta: także szkic (zdarzenia nie trzeba odtwarzać — wysyłka zaczyna się od nowa)', () => {
    const b = failedInvoiceButtons({ ...FAILED, invoiceKind: 'correction', canManage: true });
    expect(b).toMatchObject({ resend: false, reset: true });
    // A4b PR2b (decyzje 07.10.2026): zablokowany szkic → pomoc FaktWay, nie „uzgodni operator”
    // (takiej ścieżki w panelu nie ma); szkicu korekty nie wyślesz — od nowa z dzisiejszą datą.
    expect(b?.info).not.toMatch(/uzgodni (ją|go) operator/);
    expect(b?.info).toContain(SUPPORT_EMAIL);
    expect(b?.info).toBe(`${KSEF_SEND_MESSAGES.envMismatch} ${KSEF_SPECIAL_SEND_MESSAGES.envMismatchNote('correction')}`);
  });

  it('akcja „Wyślij ponownie” klienta odmawia z tym samym komunikatem', () => {
    expect(decideResend({ ...FAILED, direction: 'outgoing', invoiceKind: 'regular' })).toEqual({
      allowed: false,
      reason: 'terminal',
      message: KSEF_SEND_MESSAGES.envMismatch,
    });
  });

  it('operator: szkic bez dowodu kontaktu; ponowienie zablokowane z powodem; „Tylko uzgodnij” przy otwartym wpisie', () => {
    const clean = operatorInvoiceButtons({
      direction: 'outgoing', status: 'failed', errorCode: CODE, invoiceKind: 'regular', openSent: false, evidence: false,
      facts: STORED, environmentKnown: true,
    });
    expect(clean.reset).toEqual({ enabled: true, reason: null });
    expect(clean.requeue).toEqual({ enabled: false, reason: OPERATOR_MESSAGES.envMismatchRequeue });

    const contacted = operatorInvoiceButtons({
      direction: 'outgoing', status: 'failed', errorCode: CODE, invoiceKind: 'regular', openSent: true, evidence: true,
      facts: STORED, environmentKnown: true,
    });
    expect(contacted.reset).toEqual({ enabled: false, reason: OPERATOR_MESSAGES.evidence });
    expect(contacted.reconcile).toEqual({ enabled: true, reason: null });
  });

  it('etykieta statusu (karta faktury) mówi o środowisku, nie o błędzie treści', () => {
    const html = renderToStaticMarkup(StatusBadge({ status: 'failed', errorCode: CODE }));
    expect(html).toContain('Inne środowisko KSeF');
    expect(html).not.toContain('Błąd treści');
  });
});
