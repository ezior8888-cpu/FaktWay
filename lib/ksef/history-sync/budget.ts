/**
 * Priorytet i pojemność synchronizacji historii KSeF (decyzja Bartosza
 * 22.10.2026, punkt 4 i 5 krytyki).
 *
 * 1. USTĘPOWANIE. Historia dzieli z wysyłką i Skrzynką KSeF ten sam limit
 *    KSeF na (NIP, adres IP). Wspólnego wiadra żetonów w bazie celowo nie ma —
 *    zmieniałoby ścieżkę wysyłki i skrzynki, które chroni plan „zero
 *    zgubionych faktur”. Zamiast tego historia czyta WYŁĄCZNIE stan lokalny
 *    i ustępuje:
 *      - `yieldAll` (żadnego wywołania KSeF w tym przebiegu): firma ma fakturę
 *        w wysyłce (`queued`/`sending`) albo świeże (15 min) sprawdzenie
 *        duplikatu 440 (`failed` + `KSEF_DUPLICATE_RECONCILE`), albo HWM
 *        skrzynki jest starszy, niż pozwala poziom firmy (skrzynka nadrabia;
 *        firma gorąca 60 min, zimna kilkanaście godzin, `inbox-schedule.ts`),
 *      - `yieldDownloads` (bez pobrań XML): faktura ze skrzynki z ostatnich 2 h
 *        czeka na archiwum XML (`fa3_data._pendingFullFetch`).
 * 2. POJEMNOŚĆ. Fan-out jednego cyklu crona mieści się w 3 slotach × 13 min
 *    (szacunek czasu przebiegu) pomniejszonych o zlecenia poprzednich cykli
 *    wciąż czekające w kolejce, więc żaden przebieg nie czeka w kolejce
 *    dłużej niż próg „zaległe” heartbeatu (15 min). Reszta firm idzie
 *    w kolejnym cyklu — najdawniej obsłużone pierwsze. Szacunek wywołujący
 *    liczy z pełnym budżetem pobrań, gdy przebieg odkrywa zaległość (pobrania
 *    idą po odkrywaniu w tym samym przebiegu).
 */

import type { createAdminClient } from '@/lib/supabase/admin';

import { inboxLagYieldThresholdMs, type InboxActivityTier } from '@/lib/ksef/inbox-schedule';

import {
  FANOUT_SLOT_SECONDS,
  INBOX_LAG_YIELD_MS,
  INBOX_XML_PENDING_WINDOW_MS,
} from './constants';

type AdminClient = ReturnType<typeof createAdminClient>;

export interface YieldSignals {
  yieldAll: boolean;
  yieldDownloads: boolean;
  reasons: string[];
}

interface InboxScheduleReader {
  from(table: 'ksef_inbox_schedule'): {
    select(columns: 'activity_tier'): {
      eq(column: 'tenant_id', value: string): {
        maybeSingle(): PromiseLike<{ data: { activity_tier: InboxActivityTier } | null; error: { message: string } | null }>;
      };
    };
  };
}

/** Świeżość sprawdzenia duplikatu 440, które właśnie pobrało oryginał. */
const DUPLICATE_CHECK_WINDOW_MS = 15 * 60_000;

/**
 * Sygnały ustępowania dla firmy. Błąd odczytu RZUCA — „nie wiem” to nie
 * „można pytać KSeF” (przebieg zapisze błąd `internal`).
 */
export async function readYieldSignals(admin: AdminClient, tenantId: string, now: Date): Promise<YieldSignals> {
  const reasons: string[] = [];
  const nowMs = now.getTime();
  const [sending, duplicateCheck, cursor, pendingXml, schedule] = await Promise.all([
    admin.from('invoices').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).eq('direction', 'outgoing').in('ksef_status', ['queued', 'sending']),
    admin.from('invoices').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).eq('direction', 'outgoing').eq('ksef_status', 'failed')
      .eq('last_error_code', 'KSEF_DUPLICATE_RECONCILE')
      .gt('updated_at', new Date(nowMs - DUPLICATE_CHECK_WINDOW_MS).toISOString()),
    admin.from('ksef_inbox_cursor').select('window_to').eq('tenant_id', tenantId).maybeSingle(),
    admin.from('invoices').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).eq('direction', 'incoming')
      .eq('fa3_data->>_pendingFullFetch', 'true')
      .gt('created_at', new Date(nowMs - INBOX_XML_PENDING_WINDOW_MS).toISOString()),
    // Tabela z 00160 poza `types/database.ts`, dopóki typy nie zostaną wygenerowane z produkcji.
    (admin as unknown as InboxScheduleReader).from('ksef_inbox_schedule').select('activity_tier').eq('tenant_id', tenantId).maybeSingle(),
  ]);
  for (const r of [sending, duplicateCheck, cursor, pendingXml, schedule]) {
    if (r.error) throw new Error(`Historia KSeF: sygnały ustępowania: ${r.error.message}`);
  }

  if ((sending.count ?? 0) > 0) reasons.push('wysyłka w toku');
  if ((duplicateCheck.count ?? 0) > 0) reasons.push('świeże sprawdzenie duplikatu 440');
  const windowTo = (cursor.data as { window_to: string | null } | null)?.window_to ?? null;
  if (windowTo) {
    const hwm = Date.parse(windowTo);
    const threshold = inboxLagYieldThresholdMs(schedule.data?.activity_tier, INBOX_LAG_YIELD_MS);
    if (Number.isFinite(hwm) && nowMs - hwm > threshold) reasons.push('skrzynka nadrabia zaległość');
  }
  const yieldAll = reasons.length > 0;
  const yieldDownloads = (pendingXml.count ?? 0) > 0;
  if (yieldDownloads) reasons.push('skrzynka archiwizuje XML');
  return { yieldAll, yieldDownloads, reasons };
}

/** Szacunek czasu przebiegu firmy w sekundach: start 15 s + 5 s na zapytanie + 7 s na pobranie, najwyżej 100 s. */
export function estimateRunSeconds(work: { metadataCalls: number; downloads: number }): number {
  return Math.min(100, 15 + 5 * Math.max(0, work.metadataCalls) + 7 * Math.max(0, work.downloads));
}

export interface FanOutCandidate {
  tenantId: string;
  /** Ostatni start przebiegu (`last_run_at`) — najdawniej obsłużone pierwsze. */
  lastRunAt: string | null;
  estimateSeconds: number;
}

/**
 * Zachłanny plan cyklu: firmy od najdawniej obsłużonych (nigdy = pierwsze),
 * dopóki suma szacunków mieści się w czasie slotów. Firma, która się nie
 * mieści, czeka na kolejny cykl (`deferred`); mniejsze dalej mogą wejść.
 */
export function planFanOut<T extends FanOutCandidate>(
  candidates: readonly T[],
  slotSeconds: number = FANOUT_SLOT_SECONDS,
): { planned: T[]; deferred: T[] } {
  const ordered = candidates
    .map((c, index) => ({ c, index }))
    .sort((a, b) => {
      const at = a.c.lastRunAt ? Date.parse(a.c.lastRunAt) : Number.NEGATIVE_INFINITY;
      const bt = b.c.lastRunAt ? Date.parse(b.c.lastRunAt) : Number.NEGATIVE_INFINITY;
      return at === bt ? a.index - b.index : at - bt;
    })
    .map(({ c }) => c);
  const planned: T[] = [];
  const deferred: T[] = [];
  let used = 0;
  for (const candidate of ordered) {
    if (used + candidate.estimateSeconds <= slotSeconds) {
      planned.push(candidate);
      used += candidate.estimateSeconds;
    } else {
      deferred.push(candidate);
    }
  }
  return { planned, deferred };
}
