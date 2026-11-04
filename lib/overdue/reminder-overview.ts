import { warsawMonthBounds } from '@/lib/invoices/list-stats';
import type { PageContext } from '@/lib/supabase/page-context';

/**
 * Dane kolumn „Przypomnienie” i „Status” oraz kafla „Przypomnień wysłanych
 * w miesiącu” na `/payments/overdue` (P7, PLAN-FINORA §5).
 *
 * Logika wysyłki, zgody i harmonogramu zostaje w `lib/reminders/*` — tu
 * tylko CZYTAMY `payment_reminders` klientem z sesji (RLS) i z dwoma
 * jawnymi filtrami (firma + widoczne faktury), jak odczyt stanu „pending”
 * w samej stronie. Odczyt, którego nie da się potwierdzić w całości, daje
 * „niedostępne”, nigdy „brak przypomnień”.
 */

export const REMINDER_STAGES = ['stage_1', 'stage_2', 'stage_3', 'stage_4'] as const;
export const REMINDER_STATUSES = ['pending', 'sent', 'failed', 'cancelled'] as const;

export type ReminderStage = (typeof REMINDER_STAGES)[number];
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

export interface LatestReminder {
  /** 1–4. */
  stage: number;
  status: ReminderStatus;
  /** Znacznik czasu z bazy (UTC). */
  scheduledFor: string;
}

/** Wynik dla jednej faktury: ostatni wpis, brak wpisów albo odczyt niepewny. */
export type LatestReminderState = LatestReminder | null | 'unavailable';

export interface ReminderRow {
  invoice_id: string;
  stage: string;
  status: string;
  scheduled_for: string;
}

const STAGE_NUMBER: Record<ReminderStage, number> = { stage_1: 1, stage_2: 2, stage_3: 3, stage_4: 4 };

function isStage(value: string): value is ReminderStage {
  return (REMINDER_STAGES as readonly string[]).includes(value);
}

function isStatus(value: string): value is ReminderStatus {
  return (REMINDER_STATUSES as readonly string[]).includes(value);
}

/**
 * Ostatni wpis każdej faktury: najpóźniejszy `scheduled_for`, przy remisie
 * wyższy etap. Wiersz z nieznanym etapem, statusem albo datą, spoza
 * widocznych faktur albo zdublowany etap (w bazie `UNIQUE (invoice_id,
 * stage)`) oznacza niespójny odczyt → `null` (cała kolumna „niedostępne”).
 */
export function pickLatestReminders(
  rows: readonly ReminderRow[],
  visibleIds: readonly string[],
): Map<string, LatestReminder> | null {
  const visible = new Set(visibleIds);
  const seen = new Set<string>();
  const latest = new Map<string, LatestReminder & { at: number }>();
  for (const row of rows) {
    if (!visible.has(row.invoice_id) || !isStage(row.stage) || !isStatus(row.status)) return null;
    const at = Date.parse(row.scheduled_for);
    if (!Number.isFinite(at)) return null;
    const key = `${row.invoice_id}:${row.stage}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const stage = STAGE_NUMBER[row.stage];
    const current = latest.get(row.invoice_id);
    if (!current || at > current.at || (at === current.at && stage > current.stage)) {
      latest.set(row.invoice_id, { stage, status: row.status, scheduledFor: row.scheduled_for, at });
    }
  }
  return new Map([...latest].map(([id, { stage, status, scheduledFor }]) => [id, { stage, status, scheduledFor }]));
}

/**
 * Ostatnie przypomnienie każdej z widocznych faktur. Najwyżej 4 wiersze na
 * fakturę (cztery etapy, `UNIQUE (invoice_id, stage)`), więc odczyt jest
 * ograniczony i porównywany z dokładnym licznikiem — obcięcie po stronie
 * PostgREST daje `null` zamiast pozornego „brak”.
 */
export async function readLatestReminders(
  supabase: PageContext['supabase'],
  tenantId: string,
  visibleIds: readonly string[],
): Promise<Map<string, LatestReminder> | null> {
  if (visibleIds.length === 0) return new Map();
  const maximumRows = visibleIds.length * REMINDER_STAGES.length;
  try {
    const { data, count, error } = await supabase
      .from('payment_reminders')
      .select('invoice_id, stage, status, scheduled_for', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .in('invoice_id', [...visibleIds])
      .limit(maximumRows);
    if (error || !data || typeof count !== 'number' || count > maximumRows || count !== data.length) {
      return null;
    }
    return pickLatestReminders(data as ReminderRow[], visibleIds);
  } catch {
    return null;
  }
}

/** Północ dnia RRRR-MM-DD w Europe/Warsaw jako znacznik ISO (UTC). */
export function warsawMidnightIso(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const hourIn = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Warsaw', hour: '2-digit', hourCycle: 'h23' });
  // Polska to UTC+1 (CET) albo UTC+2 (CEST); północ lokalna to 23:00 albo 22:00 UTC dnia poprzedniego.
  for (const offsetHours of [1, 2]) {
    const candidate = new Date(Date.UTC(y, m - 1, d) - offsetHours * 3_600_000);
    if (hourIn.format(candidate) === '00') return candidate.toISOString();
  }
  return new Date(Date.UTC(y, m - 1, d) - 3_600_000).toISOString();
}

/**
 * Kafel „Przypomnień wysłanych w miesiącu”: wpisy `status = 'sent'`
 * z `sent_at` w bieżącym miesiącu (Europe/Warsaw, §2.4 pkt 10). Błąd odczytu
 * rzuca — kafel pokazuje wtedy „—”, nie „0”.
 */
export async function countRemindersSentThisMonth(
  supabase: PageContext['supabase'],
  tenantId: string,
  now: Date = new Date(),
): Promise<number> {
  const { start, endExclusive } = warsawMonthBounds(now);
  const result = await supabase
    .from('payment_reminders')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('status', 'sent')
    .gte('sent_at', warsawMidnightIso(start))
    .lt('sent_at', warsawMidnightIso(endExclusive));
  if (result.error || typeof result.count !== 'number' || !Number.isSafeInteger(result.count) || result.count < 0) {
    throw new Error('Nie można odczytać liczby wysłanych przypomnień');
  }
  return result.count;
}
