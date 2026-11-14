// Decyzje: który etap przypomnienia i kiedy zaplanować wysyłkę.

import { RECEIPT_REVENUE_COLUMNS } from '@/lib/invoices/receipt-revenue-guard';
import { inListChunks } from '@/lib/pagination/in-list';
import { forEachPageById } from '@/lib/pagination/keyset';
import { isReceiptInvoice, type ReminderChaseCandidate } from '@/lib/reminders/delivery-schema';
import { createAdminClient } from '@/lib/supabase/admin';
import { amountDueOf } from '@/lib/invoices/amount-due';
import type { Database, Json } from '@/types/database';

export type ReminderStage = Database['public']['Enums']['reminder_stage_enum'];

export interface ScheduleDecision {
  shouldSend: boolean;
  stage?: ReminderStage;
  scheduledFor?: Date;
  skipReason?: string;
}

export interface InvoiceForScheduling {
  id: string;
  tenant_id: string;
  internal_number: string | null;
  payment_due_date: string | null;
  gross_total: number | null;
  paid_amount: number | null;
  buyer_data: Json | null;
  /** Z kolumny faktury (jeśli w query) — uzupełnia NIP gdy nie ma w buyer_data */
  buyer_nip?: string | null;
  reminders_paused: boolean;
  /**
   * Opcjonalne: bez nich `amountDueOf` liczy jak zwykła faktura (gross_total).
   * Potrzebne, żeby ROZ (invoice_kind='final') nie była gonione o całe
   * zamówienie, gdy rozliczyła już zaliczkę (C-16, 00145).
   */
  invoice_kind?: string | null;
  payment_data?: Json | null;
}

const MS_PER_DAY = 86400_000;

function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value === 'string') {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

function parseDateOnlyUtc(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return new Date(Date.UTC(y, mo - 1, d));
}

function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function buyerRecord(data: Json | null): Record<string, unknown> | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return data as Record<string, unknown>;
}

function readBuyerEmail(data: Json | null): string | undefined {
  const v = buyerRecord(data)?.email;
  if (typeof v === 'string') {
    const t = v.trim();
    return t.length > 0 ? t : undefined;
  }
  return undefined;
}

function readBuyerNip(
  data: Json | null,
  columnNip?: string | null,
): string | undefined {
  const raw =
    typeof columnNip === 'string' && columnNip.trim().length > 0
      ? columnNip
      : buyerRecord(data)?.nip;
  if (typeof raw !== 'string') return undefined;
  const digits = raw.replace(/[\s-]/g, '');
  return digits.length > 0 ? digits : undefined;
}

// ============================================================================
// MAIN
// ============================================================================

export async function decideNextReminder(
  invoice: InvoiceForScheduling,
): Promise<ScheduleDecision> {
  const supabase = createAdminClient();

  const paid = toNumber(invoice.paid_amount);
  // ROZ: do zapłaty to `payment_data.amountDue` (reszta po zaliczkach), nie
  // całe `gross_total` — inaczej ROZ nigdy nie wypadłaby jako zapłacona
  // (C-16, 00145). Dla każdej innej faktury `amountDueOf` wraca do gross_total.
  const due = amountDueOf({
    invoice_kind: invoice.invoice_kind, gross_total: invoice.gross_total,
    payment_data: invoice.payment_data,
  });
  if (Number.isFinite(paid) && paid >= due) {
    return { shouldSend: false, skipReason: 'Faktura zapłacona' };
  }

  if (invoice.reminders_paused) {
    return { shouldSend: false, skipReason: 'Przypomnienia zapauzowane' };
  }

  const buyerEmail = readBuyerEmail(invoice.buyer_data);

  if (!buyerEmail) {
    return { shouldSend: false, skipReason: 'Brak emaila kontrahenta' };
  }

  const buyerNipDigits = readBuyerNip(invoice.buyer_data, invoice.buyer_nip);
  if (buyerNipDigits) {
    const { data: contractor } = await supabase
      .from('contractors')
      .select('reminder_excluded, reminder_exclusion_reason')
      .eq('tenant_id', invoice.tenant_id)
      .eq('nip', buyerNipDigits)
      .maybeSingle();

    if (contractor?.reminder_excluded) {
      return {
        shouldSend: false,
        skipReason:
          contractor.reminder_exclusion_reason ?? 'Kontrahent wykluczony',
      };
    }
  }

  const { data: settings } = await supabase
    .from('reminder_settings')
    .select('*')
    .eq('tenant_id', invoice.tenant_id)
    .maybeSingle();

  if (!settings || !settings.enabled) {
    return { shouldSend: false, skipReason: 'Wkurzacz wyłączony' };
  }

  const sentCount = await countSentReminders(invoice.id, invoice.tenant_id);
  if (sentCount >= settings.max_reminders_per_invoice) {
    return {
      shouldSend: false,
      skipReason: 'Osiągnięto limit przypomnień dla faktury',
    };
  }

  if (!invoice.payment_due_date) {
    return { shouldSend: false, skipReason: 'Brak terminu płatności' };
  }

  const dueUtc = parseDateOnlyUtc(invoice.payment_due_date);
  if (!dueUtc || Number.isNaN(dueUtc.getTime())) {
    return {
      shouldSend: false,
      skipReason: 'Niepoprawny termin płatności',
    };
  }

  const todayUtc = startOfUtcDay(new Date());

  const daysOverdue = Math.floor(
    (todayUtc.getTime() - dueUtc.getTime()) / MS_PER_DAY,
  );

  if (daysOverdue <= 0) {
    return { shouldSend: false, skipReason: 'Termin jeszcze nie minął' };
  }

  const stagesQueuedOrFinished = await getStagesAlreadyQueuedOrSent(
    invoice.id,
    invoice.tenant_id,
  );

  let nextStage: 'stage_1' | 'stage_2' | 'stage_3' | null = null;

  if (
    !stagesQueuedOrFinished.has('stage_1') &&
    settings.stage_1_enabled &&
    daysOverdue >= settings.stage_1_days_after_due
  ) {
    nextStage = 'stage_1';
  } else if (
    !stagesQueuedOrFinished.has('stage_2') &&
    settings.stage_2_enabled &&
    daysOverdue >= settings.stage_2_days_after_due
  ) {
    nextStage = 'stage_2';
  } else if (
    !stagesQueuedOrFinished.has('stage_3') &&
    settings.stage_3_enabled &&
    daysOverdue >= settings.stage_3_days_after_due
  ) {
    nextStage = 'stage_3';
  }

  if (!nextStage) {
    return {
      shouldSend: false,
      skipReason: 'Wszystkie etapy wysłane lub nie nadszedł czas',
    };
  }

  let scheduledFor = calculateScheduledTime(
    new Date(
      Date.UTC(
        todayUtc.getUTCFullYear(),
        todayUtc.getUTCMonth(),
        todayUtc.getUTCDate(),
      ),
    ),
    settings.send_hour,
  );

  if (settings.send_on_weekdays_only) {
    scheduledFor = rollToWeekdayUtc(scheduledFor, settings.send_hour);
  }

  return {
    shouldSend: true,
    stage: nextStage,
    scheduledFor,
  };
}

async function countSentReminders(invoiceId: string, tenantId: string): Promise<number> {
  const supabase = createAdminClient();
  const { count, error } = await supabase
    .from('payment_reminders')
    .select('id', { count: 'exact', head: true })
    .eq('invoice_id', invoiceId)
    .eq('tenant_id', tenantId)
    .eq('status', 'sent');

  if (error) throw new Error('Could not verify reminder limit');
  return count ?? 0;
}

async function getStagesAlreadyQueuedOrSent(
  invoiceId: string,
  tenantId: string,
): Promise<Set<ReminderStage>> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('payment_reminders')
    .select('stage, status')
    .eq('invoice_id', invoiceId)
    .eq('tenant_id', tenantId)
    .in('status', ['pending', 'sent']);

  if (error) throw new Error('Could not verify reminder stages');

  const out = new Set<ReminderStage>();
  for (const row of data ?? []) {
    if (row.stage) out.add(row.stage);
  }
  return out;
}

function calculateScheduledTime(baseUtcMidnight: Date, sendHour: number): Date {
  const hour = Math.min(Math.max(sendHour, 6), 18);
  const result = new Date(baseUtcMidnight);
  result.setUTCHours(hour, 0, 0, 0);
  const nowMs = Date.now();
  let candidate = result.getTime();

  while (candidate < nowMs) {
    candidate += MS_PER_DAY;
  }

  return new Date(candidate);
}

/** Przesuwa datę UTC na kolejny dzień roboczy (Pn–Pt), bez zmiany `send_hour` UTC. */
function rollToWeekdayUtc(scheduledFor: Date, sendHour: number): Date {
  const hour = Math.min(Math.max(sendHour, 6), 18);
  let d = new Date(scheduledFor.getTime());

  while (true) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      break;
    }
    d = new Date(d.getTime() + MS_PER_DAY);
  }

  d.setUTCHours(hour, 0, 0, 0);
  return d;
}

// ============================================================================
// Bulk: kandydaci do przebiegu crona `cron.reminder-scheduler` (pg-boss)
// ============================================================================

/**
 * Rodzaje faktur, które są osobnym długiem kontrahenta. Korekta NIE jest —
 * płatność rozlicza faktura pierwotna. Lista dozwolonych, nie „wszystko poza
 * korektą”: nowy rodzaj dokumentu nie dostaje ponagleń domyślnie.
 */
export const CHASEABLE_INVOICE_KINDS = ['regular', 'advance', 'final'] as const;

/** Wiersz kandydata z bazy (aliasy faktury do paragonu z `RECEIPT_REVENUE_COLUMNS`). */
interface CandidateRow extends ReminderChaseCandidate {
  id: string;
  tenant_id: string;
  internal_number: string | null;
  payment_due_date: string | null;
  gross_total: number | null;
  paid_amount: number | null;
  buyer_data: Json | null;
  buyer_nip: string | null;
  reminders_paused: boolean;
  invoice_kind: string | null;
  payment_data: Json | null;
}

/**
 * Faktury po terminie, kandydaci do ponaglenia, tylko podanych firm.
 *
 * Sesja 18 planu skalowania (DB-03, JOB-08). Do 13.11.2026 funkcja czytała
 * zaległe faktury WSZYSTKICH firm, także tych z wyłączonymi ponagleniami
 * (odsiew dopiero w cronie, po odczycie), i oddawała jedną tablicę z całą
 * listą: pamięć crona rosła z liczbą stron. Teraz wywołujący podaje firmy
 * (cron: te z włączonymi ponagleniami), a funkcja czyta je paczkami
 * (`inListChunks`) i stronami po `id` (`forEachPageById`). Każdą stronę
 * oddaje `onPage`, zanim zapyta o następną, więc w pamięci jest jedna strona.
 *
 * Koniec tylko na pustej stronie, więc strona ucięta przez
 * `PGRST_DB_MAX_ROWS` nie kończy odczytu po cichu. Błąd strony to wyjątek
 * `KeysetPageError` z `onPage` już wywołanym dla wcześniejszych stron.
 * Wynik: liczba stron i wierszy oddanych przez bazę (przed odsiewem FP).
 */
export async function findInvoicesRequiringReminders(
  tenantIds: readonly string[],
  onPage: (invoices: InvoiceForScheduling[]) => Promise<void>,
): Promise<{ pages: number; rows: number }> {
  const supabase = createAdminClient();

  const todaySlice = new Date().toISOString().slice(0, 10);
  let pages = 0;
  let rows = 0;

  for (const chunk of inListChunks(tenantIds)) {
    const read = await forEachPageById<CandidateRow>(
      'przypomnienia: kandydaci do ponaglenia',
      (afterId, limit) => {
        let query = supabase
          .from('invoices')
          .select(
            `id, tenant_id, internal_number, payment_due_date, gross_total, paid_amount, buyer_data, buyer_nip, reminders_paused, invoice_kind, payment_data, ${RECEIPT_REVENUE_COLUMNS}`,
          )
          .in('tenant_id', chunk)
          .eq('direction', 'outgoing')
          .eq('ksef_status', 'accepted')
          // Bez korekt: kontrahent dostawał ponaglenie za FV i drugie za jej KOR.
          .in('invoice_kind', [...CHASEABLE_INVOICE_KINDS])
          // Import historii nie zna wpłat: zaciągnięte faktury są „nieopłacone"
          // tylko dlatego. Ta sama reguła co K-01 (payment-confirm-producer).
          .eq('origin', 'app')
          .in('payment_status', ['unpaid', 'partial', 'overdue'])
          .lt('payment_due_date', todaySlice)
          .eq('reminders_paused', false);
        if (afterId) query = query.gt('id', afterId);
        return query.order('id', { ascending: true }).limit(limit);
      },
      async (page) => {
        const invoices: InvoiceForScheduling[] = [];
        for (const row of page) {
          // Krok 1.2: faktura do paragonu jest zapłacona przy kasie (status płatności zostaje,
          // ale przypomnienia dla niej nie powstają). Strona kursora liczy się bez filtra.
          if (isReceiptInvoice(row)) continue;
          invoices.push({
            id: row.id,
            tenant_id: row.tenant_id,
            internal_number: row.internal_number ?? null,
            payment_due_date: row.payment_due_date ?? null,
            gross_total: row.gross_total,
            paid_amount: row.paid_amount,
            buyer_data: row.buyer_data,
            buyer_nip: row.buyer_nip ?? null,
            reminders_paused: row.reminders_paused,
            invoice_kind: row.invoice_kind,
            payment_data: row.payment_data,
          });
        }
        if (invoices.length > 0) await onPage(invoices);
      },
    );
    pages += read.pages;
    rows += read.rows;
  }

  return { pages, rows };
}
