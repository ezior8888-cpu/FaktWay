import { readFileSync } from 'node:fs';
import path from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StatusBadge } from '@/components/invoices/status-badge';
import { ksefResendFacts, type KsefResendFacts } from '@/lib/invoices/ksef-requeue-event';
import {
  automaticResendExpected,
  canManageKsefSend,
  decideResend,
  describeResetError,
  failedInvoiceButtons,
  KSEF_SEND_MESSAGES,
  KSEF_SPECIAL_SEND_MESSAGES,
  resetDoneMessage,
  specialKindOf,
} from '@/lib/invoices/ksef-send-policy';
import { sendErrorClassOf } from '@/lib/ksef/send-error-classes';
import { SUPPORT_EMAIL } from '@/lib/site';

/**
 * Cykl życia faktury, PR 3b (K3, D2, D4): jedna tabela decyzji dla akcji
 * serwerowych i przycisków — interfejs nie pokazuje przycisku, którego
 * akcja odmówi, a `member` nie widzi „Wyślij ponownie”.
 *
 * A4b PR2b: KOR/ZAL/ROZ wysyłamy ponownie z kopii na wierszu (fakty
 * `ksefResendFacts`), tylko w dniu wystawienia (decyzja b z 06.10.2026).
 * KOR_HOLD i ROZ_HOLD_RECONCILE zostają bez przycisków klienta (decyzja a),
 * ale ze zdaniem, które nie obiecuje automatu. Kolejność blokad klienta:
 * rodzaj wstrzymany → dane → data; przy nieznanym środowisku KSeF nic nie
 * zlecamy. Decyzje z 07.10.2026: zamiast „uzgodni operator” (takiej ścieżki
 * w panelu nie ma) — adres pomocy FaktWay; „ponowimy automatycznie”
 * w zdaniu i na znaczku statusu z jednej definicji (`automaticResendExpected`).
 */

const M = KSEF_SEND_MESSAGES;
/** Teksty dokumentów specjalnych — wywoływane tylko wewnątrz testów. */
const S = KSEF_SPECIAL_SEND_MESSAGES;

/** Fakty ponowienia z kopii (A4b PR2a): dane zapisane, rodzaj niewstrzymany, dziś. */
const STORED: KsefResendFacts = { sendData: 'stored', kindHeld: false, issueDatePassed: false };
/** Stary dokument specjalny (sprzed 00137 / sprzed koperty ZAL) albo zwykła bez pozycji. */
const MISSING: KsefResendFacts = { sendData: 'missing', kindHeld: false, issueDatePassed: false };
/** Rodzaj wstrzymany w tym środowisku: KOR na PROD, ROZ wszędzie (do C4). */
const HELD: KsefResendFacts = { sendData: 'stored', kindHeld: true, issueDatePassed: false };
/** Dokument specjalny z datą wystawienia sprzed dzisiaj (00147, decyzja b). */
const PASSED: KsefResendFacts = { sendData: 'stored', kindHeld: false, issueDatePassed: true };
const ENV = { environmentKnown: true } as const;

const base = { direction: 'outgoing', invoiceKind: 'regular', facts: STORED, ...ENV } as const;

/** Wejście `decideResend` dla faktury wychodzącej z błędem wysyłki. */
const failed = (invoiceKind: string | null, errorCode: string | null, facts: KsefResendFacts, environmentKnown = true) =>
  ({ direction: 'outgoing', status: 'failed', invoiceKind, errorCode, facts, environmentKnown }) as const;

/** Przyciski właściciela przy fakturze z błędem wysyłki. */
const buttons = (invoiceKind: string | null, errorCode: string | null, facts: KsefResendFacts, environmentKnown = true) =>
  failedInvoiceButtons({ status: 'failed', invoiceKind, errorCode, facts, environmentKnown, canManage: true });

/** Zdanie obiecuje automat — po odjęciu jawnej odmowy „nie ponowimy automatycznie” (jak macierz A4). */
const promisesAutomat = (info: string | undefined) =>
  /automatycznie/.test((info ?? '').replace(/nie ponowimy automatycznie/g, ''));

describe('decideResend — kto i kiedy może wysłać ponownie', () => {
  it.each([
    ['INFRA (transient)', 'INFRA'],
    ['CREDENTIALS_UNAVAILABLE (transient)', 'CREDENTIALS_UNAVAILABLE'],
    ['NO_CERTIFICATE (setup)', 'NO_CERTIFICATE'],
    ['brak kodu (historyczny)', null],
    ['kod spoza katalogu', 'COS_STAREGO'],
  ])('failed z %s → dozwolone', (_label, errorCode) => {
    expect(decideResend({ ...base, status: 'failed', errorCode })).toMatchObject({ allowed: true });
  });

  it.each([
    ['rejected (D2: tylko szkic)', 'rejected', 'KSEF_REJECTED', 'rejected'],
    ['failed terminal (strażnik dokumentu)', 'failed', 'INVALID_DOCUMENT', 'terminal'],
    ['failed reconcile (duplikat)', 'failed', 'KSEF_DUPLICATE_RECONCILE', 'reconcile'],
    ['failed hold (hamulec)', 'failed', 'KSEF_PAUSED', 'hold'],
    ['inny status', 'accepted', null, 'status'],
    ['inny status (queued)', 'queued', null, 'status'],
  ] as const)('%s → odmowa', (_label, status, errorCode, reason) => {
    expect(decideResend({ ...base, status, errorCode })).toMatchObject({ allowed: false, reason });
  });

  it('faktura przychodząca → odmowa', () => {
    expect(decideResend({ ...base, direction: 'incoming', status: 'failed', errorCode: 'INFRA' }))
      .toMatchObject({ allowed: false, reason: 'direction' });
  });

  it('role: owner i admin tak, member i accountant nie', () => {
    expect(canManageKsefSend('owner')).toBe(true);
    expect(canManageKsefSend('admin')).toBe(true);
    expect(canManageKsefSend('member')).toBe(false);
    expect(canManageKsefSend('accountant')).toBe(false);
    expect(canManageKsefSend(null)).toBe(false);
  });
});

describe('failedInvoiceButtons — tabela stanów (sekcja 7 projektu)', () => {
  const manage = { invoiceKind: 'regular', canManage: true, facts: STORED, ...ENV };

  it('rejected → tylko „Wróć do szkicu”', () => {
    expect(failedInvoiceButtons({ ...manage, status: 'rejected', errorCode: 'KSEF_REJECTED' }))
      .toEqual({ resend: false, reset: true, settings: false, info: M.rejected });
  });

  it('failed transient → oba przyciski i informacja o automacie', () => {
    expect(failedInvoiceButtons({ ...manage, status: 'failed', errorCode: 'KSEF_UNAVAILABLE' }))
      .toEqual({ resend: true, reset: true, settings: false, info: M.transient });
  });

  it('failed setup → oba przyciski i link do ustawień KSeF', () => {
    expect(failedInvoiceButtons({ ...manage, status: 'failed', errorCode: 'NO_CERTIFICATE' }))
      .toEqual({ resend: true, reset: true, settings: true, info: M.setup });
  });

  it('failed hold / reconcile → bez przycisków, z wyjaśnieniem (KOR_HOLD bez obietnicy automatu)', () => {
    const korHold = failedInvoiceButtons({ ...manage, status: 'failed', errorCode: 'KOR_HOLD' });
    expect(korHold).toMatchObject({ resend: false, reset: false, settings: false });
    // I7 wznawia tylko KSEF_PAUSED — po zdjęciu hamulca KOR nikt jej sam nie wyśle.
    expect(korHold?.info).not.toMatch(/automatycznie/);
    expect(korHold).toEqual({ resend: false, reset: false, settings: false, info: M.korHold });
    expect(failedInvoiceButtons({ ...manage, status: 'failed', errorCode: 'RESULT_UNCERTAIN' }))
      .toEqual({ resend: false, reset: false, settings: false, info: M.reconcile });
  });

  it('failed terminal (strażnik dokumentu) → tylko szkic', () => {
    expect(failedInvoiceButtons({ ...manage, status: 'failed', errorCode: 'INVALID_DOCUMENT' }))
      .toEqual({ resend: false, reset: true, settings: false, info: M.terminal });
  });

  it('failed bez kodu (historyczny) → oba przyciski', () => {
    expect(failedInvoiceButtons({ ...manage, status: 'failed', errorCode: null }))
      .toEqual({ resend: true, reset: true, settings: false, info: M.historical });
  });

  it('korekta z kopią w dniu wystawienia (TEST): oba przyciski, automat tylko do północy; bez kopii — tylko szkic', () => {
    const stored = failedInvoiceButtons({ ...manage, status: 'failed', errorCode: 'INFRA', invoiceKind: 'correction' });
    expect(stored).toMatchObject({ resend: true, reset: true, settings: false });
    expect(stored?.info).toBe(S.transient('correction'));

    const missing = failedInvoiceButtons({
      ...manage, status: 'failed', errorCode: 'INFRA', invoiceKind: 'correction', facts: MISSING,
    });
    expect(missing).toMatchObject({ resend: false, reset: true, settings: false });
    expect(missing?.info).toBe(S.incomplete('correction'));
  });

  it('member nie widzi przycisków, dostaje prośbę o właściciela', () => {
    const plan = failedInvoiceButtons({ ...manage, status: 'failed', errorCode: 'INFRA', canManage: false });
    expect(plan).toMatchObject({ resend: false, reset: false });
    expect(plan?.info).toContain(M.askManager);
  });

  it('stany bez błędu → null', () => {
    for (const status of ['draft', 'queued', 'sending', 'accepted', 'offline_queued']) {
      expect(failedInvoiceButtons({ ...manage, status, errorCode: null })).toBeNull();
    }
  });
});

describe('A4b PR2b: dokument specjalny wysyłany ponownie z kopii (decyzja b) i blokady klienta', () => {
  it('ZAL z kopią w dniu wystawienia (KSEF_UNAVAILABLE) i KOR z kopią na TEST (INFRA) → dozwolone', () => {
    expect(decideResend(failed('advance', 'KSEF_UNAVAILABLE', STORED))).toEqual({ allowed: true, errorClass: 'transient' });
    expect(decideResend(failed('correction', 'INFRA', STORED))).toEqual({ allowed: true, errorClass: 'transient' });
  });

  it('ZAL INFRA z kopią → oba przyciski; automat tylko do północy, bez bezwarunkowego „ponowimy automatycznie”', () => {
    const b = buttons('advance', 'INFRA', STORED);
    expect(b).toMatchObject({ resend: true, reset: true, settings: false });
    expect(b?.info).toContain('do północy');
    expect(b?.info).not.toContain('ponowimy automatycznie');
    expect(b?.info).toBe(S.transient('advance'));
  });

  it('ZAL INFRA bez kopii (sprzed koperty) → tylko „Wróć do szkicu”; adres pomocy zamiast „uzgodni operator”', () => {
    const d = decideResend(failed('advance', 'INFRA', MISSING));
    expect(d).toMatchObject({ allowed: false, reason: 'incomplete' });
    const b = buttons('advance', 'INFRA', MISSING);
    expect(b).toMatchObject({ resend: false, reset: true, settings: false });
    expect(b?.info).toContain(SUPPORT_EMAIL);
    expect(b?.info).not.toMatch(/uzgodni/);
    expect(d).toEqual({ allowed: false, reason: 'incomplete', message: S.incomplete('advance') });
    expect(b?.info).toBe(S.incomplete('advance'));
  });

  it.each([
    ['KOR z kopią, rodzaj wstrzymany (PROD)', 'correction', HELD],
    ['ROZ bez kopii (hamulec ROZ wszędzie — rodzaj wygrywa z danymi)', 'final', { sendData: 'missing', kindHeld: true, issueDatePassed: false }],
  ] as const)('%s → „kind-held”: tylko szkic, wystawienie od nowa dopiero po zdjęciu blokady', (_label, kind, facts) => {
    const d = decideResend(failed(kind, 'INFRA', facts));
    expect(d).toMatchObject({ allowed: false, reason: 'kind-held' });
    const b = buttons(kind, 'INFRA', facts);
    expect(b).toMatchObject({ resend: false, reset: true, settings: false });
    expect(b?.info).toContain('po zdjęciu blokady');
    expect(b?.info).toContain(SUPPORT_EMAIL);
    expect(b?.info).toBe(S.kindHeld(kind));
    expect(b?.info).not.toBe(S.incomplete(kind));
  });

  it('KOR INFRA z kopią po dacie wystawienia → „issue-date”: tylko szkic, z powodem daty', () => {
    const d = decideResend(failed('correction', 'INFRA', PASSED));
    expect(d).toMatchObject({ allowed: false, reason: 'issue-date' });
    const b = buttons('correction', 'INFRA', PASSED);
    expect(b).toMatchObject({ resend: false, reset: true, settings: false });
    expect(b?.info).toMatch(/datę wystawienia sprzed dzisiaj/);
    expect(b?.info).not.toMatch(/uzgodni/);
    expect(b?.info).toBe(S.issueDatePassed('correction'));
  });

  it.each([
    ['ZAL bez kopii', 'advance', MISSING, 'incomplete', (): string => S.incomplete('advance')],
    ['zwykła bez danych', 'regular', MISSING, 'incomplete', (): string => M.incomplete],
    ['KOR z rodzajem wstrzymanym (PROD)', 'correction', HELD, 'kind-held', (): string => S.kindHeld('correction')],
    ['ZAL po dacie wystawienia', 'advance', PASSED, 'issue-date', (): string => S.issueDatePassed('advance')],
  ] as const)('KSEF_PAUSED, %s → I7 tego nie wznowi: blokada i „Wróć do szkicu”, nie „wyjdzie automatycznie”', (_label, kind, facts, reason, message) => {
    const d = decideResend(failed(kind, 'KSEF_PAUSED', facts));
    expect(d).toMatchObject({ allowed: false, reason });
    const b = buttons(kind, 'KSEF_PAUSED', facts);
    expect(b).toMatchObject({ resend: false, reset: true, settings: false });
    expect(b?.info).not.toBe(M.hold);
    expect(promisesAutomat(b?.info)).toBe(false);
    expect(b?.info).toBe(message());
  });

  it('KSEF_PAUSED, ZAL z kopią w dniu wystawienia → bez przycisków; automat tylko przed północą', () => {
    const b = buttons('advance', 'KSEF_PAUSED', STORED);
    expect(b).toMatchObject({ resend: false, reset: false, settings: false });
    expect(b?.info).toContain('przed północą');
    expect(b?.info).toBe(S.paused('advance'));
    expect(decideResend(failed('advance', 'KSEF_PAUSED', STORED)))
      .toEqual({ allowed: false, reason: 'hold', message: S.paused('advance') });
  });

  it('strażnik: KSEF_PAUSED, zwykła z danymi → bez przycisków, M.hold (I7 wznowi po zdjęciu hamulca)', () => {
    expect(buttons('regular', 'KSEF_PAUSED', STORED)).toEqual({ resend: false, reset: false, settings: false, info: M.hold });
  });

  it('ISSUE_DATE_PASSED, ZAL → tylko szkic; zdanie z rodzajem dokumentu i adresem pomocy, bez „uzgodni operator”', () => {
    const b = buttons('advance', 'ISSUE_DATE_PASSED', PASSED);
    expect(b).toMatchObject({ resend: false, reset: true, settings: false });
    expect(b?.info).not.toMatch(/uzgodni/);
    expect(b?.info).toContain('faktury zaliczkowej');
    expect(b?.info).toContain(SUPPORT_EMAIL);
    expect(b?.info).toBe(S.issueDatePassedCode('advance'));
    expect(decideResend(failed('advance', 'ISSUE_DATE_PASSED', PASSED)))
      .toEqual({ allowed: false, reason: 'terminal', message: S.issueDatePassedCode('advance') });
  });

  it('rejected, korekta → tylko szkic; „usuń i wystaw od nowa”, nie „popraw i wyślij ponownie” (szkicu korekty nie wyślesz)', () => {
    const d = decideResend({ ...failed('correction', 'KSEF_REJECTED', STORED), status: 'rejected' });
    expect(d).toMatchObject({ allowed: false, reason: 'rejected' });
    expect((d as { message: string }).message).not.toMatch(/popraw i wyślij ponownie/);
    const b = failedInvoiceButtons({
      status: 'rejected', errorCode: 'KSEF_REJECTED', invoiceKind: 'correction', facts: STORED, ...ENV, canManage: true,
    });
    expect(b).toMatchObject({ resend: false, reset: true, settings: false });
    expect(b?.info).not.toMatch(/popraw i wyślij ponownie/);
    expect(d).toEqual({ allowed: false, reason: 'rejected', message: S.rejected('correction') });
    expect(b?.info).toBe(S.rejected('correction'));
  });

  it.each([
    ['CREDENTIALS_UNAVAILABLE', 'CREDENTIALS_UNAVAILABLE', false, (): string => M.transientManual],
    ['NOT_IN_KSEF', 'NOT_IN_KSEF', false, (): string => M.notInKsef],
    ['NO_CERTIFICATE (link do ustawień)', 'NO_CERTIFICATE', true, (): string => M.setup],
    ['brak kodu (historyczny)', null, false, (): string => M.historical],
  ] as const)('ZAL z kopią w dniu wystawienia, %s → oba przyciski; zdanie kończy się „tylko dziś”, bez obietnicy automatu', (_label, code, settings, baseInfo) => {
    const b = buttons('advance', code, STORED);
    expect(b).toMatchObject({ resend: true, reset: true, settings });
    // „nie ponowimy automatycznie” (transientManual) to odmowa, nie obietnica — liczymy jak macierz A4.
    expect(promisesAutomat(b?.info)).toBe(false);
    expect(b?.info.endsWith(S.sendToday('advance'))).toBe(true);
    expect(b?.info).toBe(`${baseInfo()} ${S.sendToday('advance')}`);
  });

  it.each([
    ['NULL', null],
    ['spoza listy', 'proforma'],
  ] as const)('rodzaj %s (fakty: brak danych, rodzaj wstrzymany) → „incomplete”, nigdy domyślnie zwykła', (_label, kind) => {
    const facts: KsefResendFacts = { sendData: 'missing', kindHeld: true, issueDatePassed: false };
    expect(decideResend(failed(kind, 'INFRA', facts))).toMatchObject({ allowed: false, reason: 'incomplete' });
    expect(buttons(kind, 'INFRA', facts)).toEqual({ resend: false, reset: true, settings: false, info: M.incomplete });
    expect(specialKindOf(kind)).toBeNull();
    expect(specialKindOf('regular')).toBeNull();
    expect(specialKindOf('correction')).toBe('correction');
    expect(specialKindOf('advance')).toBe('advance');
    expect(specialKindOf('final')).toBe('final');
  });
});

describe('A4b PR2b: KOR_HOLD i ROZ_HOLD_RECONCILE — bez przycisków klienta (decyzja a), zdanie bez obietnicy automatu', () => {
  const holdRows = ([
    ['KOR_HOLD', 'correction'],
    ['KOR_HOLD', 'regular'],
    ['ROZ_HOLD_RECONCILE', 'final'],
  ] as const).flatMap(([code, kind]) => ([
    ['z kopią', STORED],
    ['rodzaj wstrzymany', HELD],
    ['bez kopii', MISSING],
  ] as const).map(([label, facts]) => [code, kind, label, facts] as const));

  it.each(holdRows)('strażnik (decyzja a): %s, %s, %s → bez przycisków klienta', (code, kind, _label, facts) => {
    expect(buttons(kind, code, facts)).toMatchObject({ resend: false, reset: false, settings: false });
    expect(decideResend(failed(kind, code, facts))).toMatchObject({ allowed: false, reason: 'hold' });
  });

  it.each(holdRows)('%s, %s, %s → „sami nie wyślemy” i adres pomocy, nie „wyjdzie automatycznie”', (code, kind, _label, facts) => {
    const b = buttons(kind, code, facts);
    expect(b?.info).not.toMatch(/automatycznie/);
    expect(b?.info).toContain(SUPPORT_EMAIL);
    const expected = code === 'KOR_HOLD' ? M.korHold : M.rozHold;
    expect(b?.info).toBe(expected);
    expect(decideResend(failed(kind, code, facts))).toEqual({ allowed: false, reason: 'hold', message: expected });
  });
});

describe('A2b / A4b PR2b: zdanie o automacie wg kodu (AUTO_REQUEUE_CODES), nie wg klasy transient', () => {
  it.each(['CREDENTIALS_UNAVAILABLE', 'TRANSIENT_EXHAUSTED'])(
    'zwykła, %s (transient bez automatu) → oba przyciski, zdanie bez obietnicy automatu',
    (code) => {
      const b = buttons('regular', code, STORED);
      expect(promisesAutomat(b?.info)).toBe(false);
      expect(b).toEqual({ resend: true, reset: true, settings: false, info: M.transientManual });
      expect(b?.info).toContain(SUPPORT_EMAIL);
    },
  );
});

describe('A4b PR2b: nieznane środowisko KSeF po stronie FaktWay (environmentKnown)', () => {
  it.each([
    ['zwykła INFRA', 'regular', 'INFRA', STORED],
    ['KOR INFRA (bez środowiska rodzaj wstrzymany — nie mówimy o hamulcu PROD)', 'correction', 'INFRA', HELD],
    ['ZAL KSEF_PAUSED', 'advance', 'KSEF_PAUSED', HELD],
  ] as const)('%s → „env-unknown”: bez przycisków, prośba o odświeżenie i adres pomocy', (_label, kind, code, facts) => {
    const b = buttons(kind, code, facts, false);
    expect(b).toMatchObject({ resend: false, reset: false, settings: false });
    expect(decideResend(failed(kind, code, facts, false))).toMatchObject({ allowed: false, reason: 'env-unknown' });
    expect(b?.info).toBe(M.envUnknown);
    expect(M.envUnknown).toContain(SUPPORT_EMAIL);
  });

  it('strażnik: środowisko nieznane, rejected → nadal „Wróć do szkicu” (powrót niczego nie wysyła)', () => {
    expect(failedInvoiceButtons({
      status: 'rejected', errorCode: 'KSEF_REJECTED', invoiceKind: 'regular', facts: STORED, environmentKnown: false, canManage: true,
    })).toEqual({ resend: false, reset: true, settings: false, info: M.rejected });
  });
});

describe('A4b PR2b: komunikat po powrocie do szkicu (resetDoneMessage)', () => {
  it('dokument specjalny: „Usuń szkic” i wystaw od nowa, nie „wyślij ponownie”; rodzaj wstrzymany — po zdjęciu blokady; zwykła bez zmian', () => {
    const kor = resetDoneMessage('correction', STORED);
    expect(kor).not.toBe(M.resetDone);
    expect(kor).toContain('Usuń szkic');
    expect(kor.toLowerCase()).not.toContain('wyślij ponownie');
    expect(resetDoneMessage('correction', HELD)).toContain('po zdjęciu blokady');
    expect(resetDoneMessage('advance', STORED)).toBe(S.resetDone('advance'));
    expect(resetDoneMessage('final', HELD)).toBe(S.resetDoneHeld('final'));
    expect(resetDoneMessage('regular', STORED)).toBe(M.resetDone);
  });
});

describe('KSEF_NUMBER_TAKEN — akcja odmawia tym samym zdaniem, które stoi nad przyciskami', () => {
  it('decideResend: M.numberTaken, nie ogólny „błąd treści”', () => {
    expect(decideResend(failed('regular', 'KSEF_NUMBER_TAKEN', STORED)))
      .toEqual({ allowed: false, reason: 'terminal', message: M.numberTaken });
    expect(buttons('regular', 'KSEF_NUMBER_TAKEN', STORED)?.info).toBe(M.numberTaken);
  });
});

describe('automaticResendExpected — jedna definicja automatu dla zdania i znaczka (decyzja 10 z 07.10.2026)', () => {
  const rows = [
    ['zwykła CREDENTIALS_UNAVAILABLE', 'regular', 'CREDENTIALS_UNAVAILABLE', STORED, true, false],
    ['zwykła TRANSIENT_EXHAUSTED', 'regular', 'TRANSIENT_EXHAUSTED', STORED, true, false],
    ['zwykła NOT_IN_KSEF', 'regular', 'NOT_IN_KSEF', STORED, true, false],
    ['zwykła KSEF_UNAVAILABLE', 'regular', 'KSEF_UNAVAILABLE', STORED, true, true],
    ['ZAL KSEF_UNAVAILABLE w dniu wystawienia', 'advance', 'KSEF_UNAVAILABLE', STORED, true, true],
    ['ZAL KSEF_UNAVAILABLE po dacie wystawienia', 'advance', 'KSEF_UNAVAILABLE', PASSED, true, false],
    ['ZAL INFRA bez kopii', 'advance', 'INFRA', MISSING, true, false],
    ['KOR INFRA, rodzaj wstrzymany (PROD)', 'correction', 'INFRA', HELD, true, false],
    ['zwykła KSEF_PAUSED z danymi', 'regular', 'KSEF_PAUSED', STORED, true, true],
    ['ZAL KSEF_PAUSED w dniu wystawienia', 'advance', 'KSEF_PAUSED', STORED, true, true],
    ['KOR_HOLD (I7 go nie wznawia)', 'correction', 'KOR_HOLD', STORED, true, false],
    ['zwykła KSEF_UNAVAILABLE, środowisko nieznane', 'regular', 'KSEF_UNAVAILABLE', STORED, false, false],
  ] as const;

  it('zdanie nad przyciskami obiecuje automat dokładnie tam, gdzie cron I6/I7 ponowi — i to samo mówi automaticResendExpected', () => {
    const mismatches = rows
      .filter(([, kind, code, facts, environmentKnown, expected]) =>
        promisesAutomat(buttons(kind, code, facts, environmentKnown)?.info) !== expected)
      .map(([label]) => label);
    expect(mismatches).toEqual([]);
    for (const [label, kind, code, facts, environmentKnown, expected] of rows) {
      expect(automaticResendExpected({ status: 'failed', errorCode: code, invoiceKind: kind, facts, environmentKnown }), label)
        .toBe(expected);
    }
    for (const status of ['rejected', 'queued', 'accepted']) {
      expect(automaticResendExpected({
        status, errorCode: 'KSEF_UNAVAILABLE', invoiceKind: 'regular', facts: STORED, environmentKnown: true,
      }), status).toBe(false);
    }
  });

  const transientRows = rows.filter(([, , code]) => sendErrorClassOf(code) === 'transient');

  it.each(transientRows.filter((row) => !row[5]))(
    'znaczek statusu, %s: bez automatu — „Błąd wysyłki”, nie „Błąd — ponawiamy”',
    (_label, _kind, code) => {
      const html = renderToStaticMarkup(StatusBadge({ status: 'failed', errorCode: code, automaticResend: false }));
      expect(html).not.toContain('ponawiamy');
      expect(html).toContain('Błąd wysyłki');
    },
  );

  it.each(transientRows.filter((row) => row[5]))(
    'strażnik: znaczek statusu, %s: automat — „Błąd — ponawiamy”',
    (_label, _kind, code) => {
      const html = renderToStaticMarkup(StatusBadge({ status: 'failed', errorCode: code, automaticResend: true }));
      expect(html).toContain('Błąd — ponawiamy');
    },
  );

  it('strażnik: listy faktur (bez kodu błędu) zostają przy „Błąd”', () => {
    const html = renderToStaticMarkup(StatusBadge({ status: 'failed' }));
    // Plakietka Finory (E3b) nie ma już kropki przed etykietą — wciąż cała etykieta to samo „Błąd”.
    expect(html).toMatch(/>Błąd<\/span>/);
  });
});

describe('fakty z prawdziwego ksefResendFacts — strona otwarta po północy (A4b PR2b)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-02T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** ZAL w kształcie INSERT-u: koperta w `fa3_data.advanceEnvelope`, `special_data` NULL (fikcyjny NIP). */
  const zal = (issueDate: string) => ({
    invoice_kind: 'advance',
    issue_date: issueDate,
    fa3_data: {
      issueDate,
      seller: { nip: '1234567890' },
      lines: [{ name: 'Zaliczka na dostawę' }],
      advanceEnvelope: { issueDate },
    },
    special_data: null,
  });

  it('ZAL z wczoraj → „issue-date” (tylko szkic); ta sama ZAL z dzisiaj → „Wyślij ponownie”', () => {
    const passed = ksefResendFacts(zal('2026-10-01'), 'test');
    expect(passed).toEqual(PASSED);
    expect(decideResend(failed('advance', 'KSEF_UNAVAILABLE', passed))).toMatchObject({ allowed: false, reason: 'issue-date' });
    expect(buttons('advance', 'KSEF_UNAVAILABLE', passed)).toMatchObject({ resend: false, reset: true });

    const today = ksefResendFacts(zal('2026-10-02'), 'test');
    expect(today).toEqual(STORED);
    expect(buttons('advance', 'KSEF_UNAVAILABLE', today)).toMatchObject({ resend: true, reset: true });
    expect(buttons('advance', 'KSEF_UNAVAILABLE', passed)?.info).toBe(S.issueDatePassed('advance'));
  });
});

describe('strażnik: polityka zostaje czystym modułem (komponent kliencki i worker)', () => {
  it('ksef-requeue-event tylko jako `import type`; bez claim-environment, submission-holds i @/lib/supabase', () => {
    const source = readFileSync(path.join(process.cwd(), 'lib/invoices/ksef-send-policy.ts'), 'utf8');
    const statements = [...source.matchAll(/^(import|export)\s+(type\s+)?[^;'"]*?\bfrom\s+['"]([^'"]+)['"]/gm)];
    const modules = statements.map((m) => m[3]);
    expect(modules.length).toBeGreaterThan(0);
    for (const statement of statements.filter((m) => /ksef-requeue-event$/.test(m[3]))) {
      expect(statement[0], statement[0]).toMatch(/^import type\s/);
    }
    expect(modules.filter((m) => /claim-environment|submission-holds|^@\/lib\/supabase/.test(m))).toEqual([]);
    expect(source).not.toMatch(/\bimport\(|\brequire\(/);
  });
});

describe('describeResetError', () => {
  it('P0001 niesie komunikat RPC, P0002 brak faktury, reszta ogólny', () => {
    expect(describeResetError({ code: 'P0001', message: 'Faktura mogła dotrzeć do KSeF — wymaga uzgodnienia, nie powrotu do szkicu' }))
      .toBe('Faktura mogła dotrzeć do KSeF — wymaga uzgodnienia, nie powrotu do szkicu');
    expect(describeResetError({ code: 'P0002', message: 'x' })).toBe(M.notFound);
    expect(describeResetError({ code: '08006', message: 'connection' })).toBe(M.resetFailed);
  });
});

describe('A4b PR2b (recenzja): rodzaj wstrzymany — szkic tak, nowy dokument dopiero po zdjęciu blokady', () => {
  // KOR na PROD (KOR_HOLD) i ROZ wszędzie: nowej korekty / faktury rozliczeniowej kolejkowanie i tak nie wyśle,
  // więc żaden tekst nie może kazać „wystawić od nowa” teraz (reguła z nagłówka polityki).
  it.each([
    ['ENV_MISMATCH, korekta', 'correction', 'failed', 'ENV_MISMATCH'],
    ['ENV_MISMATCH, ROZ', 'final', 'failed', 'ENV_MISMATCH'],
    ['błąd treści (INVALID_DOCUMENT), korekta', 'correction', 'failed', 'INVALID_DOCUMENT'],
    ['błąd treści (XSD_INVALID), ROZ', 'final', 'failed', 'XSD_INVALID'],
    ['ISSUE_DATE_PASSED, korekta', 'correction', 'failed', 'ISSUE_DATE_PASSED'],
    ['odrzucona przez KSeF, korekta', 'correction', 'rejected', 'KSEF_REJECTED'],
    ['odrzucona przez KSeF, ROZ', 'final', 'rejected', 'KSEF_REJECTED'],
  ] as const)('%s: „Wróć do szkicu”, a nowy dokument po zdjęciu blokady (z adresem pomocy)', (_name, kind, status, code) => {
    const b = failedInvoiceButtons({ status, invoiceKind: kind, errorCode: code, facts: HELD, environmentKnown: true, canManage: true });
    expect(b?.reset).toBe(true);
    expect(b?.resend).toBe(false);
    expect(b?.info).toMatch(/po zdjęciu blokady/);
    expect(b?.info).not.toMatch(/od nowa z dzisiejszą datą/);
    expect(b?.info).not.toMatch(/od nowa z poprawionymi danymi/);
    expect(b?.info).toContain(SUPPORT_EMAIL);
  });

  it('strażnik: rodzaj niewstrzymany (KOR na TEST) — błąd treści dalej każe wystawić od nowa z poprawionymi danymi', () => {
    const b = failedInvoiceButtons({ status: 'failed', invoiceKind: 'correction', errorCode: 'INVALID_DOCUMENT', facts: STORED, environmentKnown: true, canManage: true });
    expect(b?.info).toMatch(/od nowa z poprawionymi danymi/);
    expect(b?.info).not.toMatch(/po zdjęciu blokady/);
  });
});
