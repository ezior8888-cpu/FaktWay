// Cron job: re-trigger UPO download dla faktur akceptowanych w KSeF, dla których
// UPO nie pojawiło się w ciągu 24h (Faza 23 sekcja 3). Obejmuje także
// zaakceptowane faktury wychodzące bez rekordu UPO po utracie zdarzenia.
//
// Typowy scenariusz: KSeF zaakceptował fakturę (`ksef_status='accepted'`),
// emitowaliśmy `invoice/upo.requested`, ale `downloadUpoJob` padł 5× z 5xx
// po stronie MF (system raportów obciążony) i status `upo_receipts` utknął
// na `pending` lub `failed`. UPO to dokument prawny — bez niego klient nie
// ma dowodu w razie kontroli skarbowej, więc nie odpuszczamy.
//
// Trigger: co godzinę o pełnej minucie (dawniej synchronicznie z `refresh-materialized-views`,
// żeby operator widział obie aktywności w jednym oknie monitoringu).
//
// Rate limit: max 100 retry per uruchomienie, żeby cron nie zatkał kolejki
// Inngest gdy zaległości urosną do tysięcy (np. po długiej awarii MF).

import { NonRetriableError } from '../errors';
import type { JobContext } from '@/lib/jobs/registry';
import * as Sentry from '@sentry/nextjs';

import { createAdminClient } from '@/lib/supabase/admin';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { assertJobIdentity } from './tenant-boundary';
import { assertUpoIdentity, assertUpoReceipt, matchesUpoInvoice, requireAcceptedUpoInvoice, UpoIdentityMismatchError, UPO_IDENTITY_MISMATCH } from './upo-identity';

const STALE_HOURS = 24;
const MAX_RETRIES_PER_RUN = 100;
// A full page of pending/failed receipts must not hide invoices without a
// receipt. At least 50 event slots remain for the two missing-receipt scans.
const STALE_RETRY_BUDGET = 50;
const LEGACY_MISSING_RESERVE = 25;
const MISSING_PAGE_SIZE = 50;
const MAX_MISSING_SCAN_PAGES = 4;

interface StaleUpoRow {
  id: string;
  invoice_id: string;
  tenant_id: string;
  ksef_number: string;
  ksef_environment: string | null;
  status: 'pending' | 'failed';
  download_attempts: number;
  invoices: {
    id: string;
    tenant_id: string;
    ksef_number: string | null;
    ksef_status: string | null;
    ksef_environment: string | null;
  } | null;
}

const RETRY_COLUMNS = 'id, invoice_id, tenant_id, ksef_number, ksef_environment, status, download_attempts, invoices(id, tenant_id, ksef_number, ksef_status, ksef_environment)' as const;
/**
 * Skan zaległych UPO: osadzenie `invoices!inner` z polem wyliczanym
 * `ksef_upo_expected` (00155, decyzja Bartosza 22.10.2026) — UPO istnieje tylko
 * dla faktur wysłanych sesją FaktWay; faktura z historii KSeF bez związku
 * z naszą wysyłką go nie ma i nie może być ponawiana co godzinę.
 * PostgREST przyjmuje filtr pola wyliczanego na osadzeniu (dowód:
 * tests/rls-historia-ksef.test.ts).
 */
const STALE_SCAN_COLUMNS = 'id, invoice_id, tenant_id, ksef_number, ksef_environment, status, download_attempts, invoices!inner(id, tenant_id, ksef_number, ksef_status, ksef_environment)' as const;
/** Jedno źródło odpowiedzi „ta faktura powinna mieć UPO” (00155). */
const UPO_EXPECTED = 'ksef_upo_expected';

interface MissingUpoInvoice {
  id: string;
  tenant_id: string;
  direction: string;
  ksef_number: string | null;
  ksef_status: string | null;
  ksef_environment: string | null;
  ksef_accepted_at: string | null;
  submitted_to_ksef_at: string | null;
  updated_at: string | null;
  created_at: string | null;
  seller_nip: string | null;
  tenants: { id: string; nip: string | null } | { id: string; nip: string | null }[] | null;
}

const MISSING_COLUMNS = 'id, tenant_id, direction, ksef_number, ksef_status, ksef_environment, ksef_accepted_at, submitted_to_ksef_at, updated_at, created_at, seller_nip, tenants(id, nip)' as const;

function oldEnoughForUpoRecovery(invoice: MissingUpoInvoice, cutoffIso: string): boolean {
  // Accepted-at is authoritative. For legacy NULL rows the actual submit
  // timestamp wins over later payment/reminder updates. With no submit stamp,
  // updated-at is only a conservative fallback; its continuous changes need
  // manual reconciliation instead of guessing when KSeF accepted the invoice.
  const date = invoice.ksef_accepted_at ?? invoice.submitted_to_ksef_at ??
    invoice.updated_at ?? invoice.created_at;
  const cutoff = Date.parse(cutoffIso);
  const timestamp = date ? Date.parse(date) : Number.NaN;
  return Number.isFinite(timestamp) && timestamp < cutoff;
}

/** Recheck an anti-join result outside durable step caches before producing an event. */
async function readEligibleMissingInvoice(
  identity: { invoiceId: string; tenantId: string; ksefNumber: string },
  environment: 'test' | 'demo' | 'production',
  cutoffIso: string,
): Promise<MissingUpoInvoice | null> {
  const { data, error } = await createAdminClient().from('invoices')
    .select(MISSING_COLUMNS)
    .eq('id', identity.invoiceId).eq('tenant_id', identity.tenantId)
    .eq('direction', 'outgoing').eq('ksef_status', 'accepted')
    .eq('ksef_number', identity.ksefNumber).eq('ksef_environment', environment)
    .filter(UPO_EXPECTED, 'eq', 'true')
    .maybeSingle();
  if (error) throw new Error('Nie można sprawdzić zaakceptowanej faktury bez UPO');
  const invoice = data as unknown as MissingUpoInvoice | null;
  if (!invoice || !matchesUpoInvoice(invoice, identity) ||
      invoice.direction !== 'outgoing' || !oldEnoughForUpoRecovery(invoice, cutoffIso)) return null;
  const tenant = Array.isArray(invoice.tenants) ? invoice.tenants[0] : invoice.tenants;
  if (tenant && tenant.id !== identity.tenantId) {
    Sentry.captureMessage('UPO retry skipped — inconsistent invoice tenant relation', { level: 'warning' });
    return null;
  }
  return invoice;
}

/** Shared runner for Inngest and pg-boss; no authorization is trusted from step caches. */
export async function runUpoRetryStale({ step, logger }: JobContext) {
  const environment = requireConfiguredKsefEnvironment();
  const cutoffIso = new Date(Date.now() - STALE_HOURS * 60 * 60 * 1000).toISOString();
  const stale = await step.run('find-stale-upo', async () => {
    const { data, error } = await createAdminClient().from('upo_receipts')
      .select(STALE_SCAN_COLUMNS).in('status', ['pending', 'failed'])
      .eq('ksef_environment', environment)
      .filter(`invoices.${UPO_EXPECTED}`, 'eq', 'true')
      .or('last_error.is.null,last_error.neq.' + UPO_IDENTITY_MISMATCH)
      .lt('created_at', cutoffIso).order('created_at', { ascending: true })
      .limit(STALE_RETRY_BUDGET);
    if (error) throw new Error('Nie można sprawdzić zaległych UPO');
    return (data ?? []) as unknown as StaleUpoRow[];
  });
  if (stale.length) logger.info('UPO retry: znaleziono zaległości', { count: stale.length, cutoffIso });

  const events: Array<{ name: 'invoice/upo.requested'; groupId: string; data: {
    invoiceId: string; tenantId: string; ksefNumber: string; nip: string;
    environment: 'test' | 'demo' | 'production';
  } }> = [];
  let quarantined = 0;
  for (const candidate of stale) {
    const identity = { invoiceId: candidate.invoice_id, tenantId: candidate.tenant_id, ksefNumber: candidate.ksef_number };
    // UUID columns cannot contain malformed IDs, but old/cached results are untrusted.
    // A malformed reference CAN be stored in the text column: quarantine it below
    // only after reading the same receipt freshly, without aborting the batch.
    try {
      assertJobIdentity(candidate.id, candidate.tenant_id);
      assertJobIdentity(candidate.invoice_id, candidate.tenant_id);
      if (typeof candidate.ksef_number !== 'string') continue;
    } catch (error) {
      if (!(error instanceof NonRetriableError)) throw error;
      Sentry.captureMessage('UPO retry skipped — malformed candidate identity', { level: 'warning' });
      continue;
    }
    if (candidate.ksef_environment !== environment ||
        candidate.invoices?.ksef_environment !== environment) {
      Sentry.captureMessage('UPO retry blocked — invoice environment requires reconciliation', { level: 'warning' });
      continue;
    }
    // A cached candidate can have been repaired, removed, completed or quarantined.
    const { data, error } = await createAdminClient().from('upo_receipts')
      .select(RETRY_COLUMNS).eq('id', candidate.id).eq('tenant_id', identity.tenantId)
      .eq('invoice_id', identity.invoiceId).eq('ksef_number', identity.ksefNumber)
      .in('status', ['pending', 'failed'])
      .or('last_error.is.null,last_error.neq.' + UPO_IDENTITY_MISMATCH).maybeSingle();
    if (error) throw new Error('Nie można ponownie sprawdzić zaległego UPO');
    if (!data) continue;
    const row = data as unknown as StaleUpoRow;
    assertUpoReceipt(row, identity, candidate.id);
    const joinedMatches = matchesUpoInvoice(row.invoices, identity);
    let invoice;
    try {
      // Separate fresh lookup also distinguishes a confirmed mismatch from a DB outage.
      invoice = await requireAcceptedUpoInvoice(identity);
    } catch (error) {
      if (!(error instanceof UpoIdentityMismatchError)) throw error;
      const { data: changed, error: updateError } = await createAdminClient().from('upo_receipts')
        .update({ status: 'failed', last_error: UPO_IDENTITY_MISMATCH })
        .eq('id', row.id).eq('tenant_id', row.tenant_id).eq('invoice_id', row.invoice_id)
        .eq('ksef_number', row.ksef_number).eq('status', row.status)
        .select('id');
      if (updateError) throw new Error('Nie można odseparować niespójnego UPO');
      quarantined += changed?.length ?? 0;
      Sentry.captureMessage('UPO retry skipped — inconsistent invoice relation', { level: 'warning' });
      continue;
    }
    if (!joinedMatches) {
      // Relation changed between the joined read and the independent lookup.
      // Leave it for the next fresh run instead of dispatching mixed snapshots.
      continue;
    }
    const tenant = Array.isArray(invoice.tenants) ? invoice.tenants[0] : invoice.tenants;
    const nip = tenant?.nip ?? invoice.seller_nip;
    if (!nip) {
      Sentry.captureMessage('UPO retry skipped — brak NIP-u dla invoice', { level: 'warning' });
      continue;
    }
    // groupId = NIP: limit „3 naraz per NIP” w pg-boss działa tylko z grupą (AUD-92).
    events.push({ name: 'invoice/upo.requested', groupId: nip, data: { ...identity, nip, environment } });
  }
  type MissingCandidate = { id: string; tenant_id: string; ksef_number: string };
  // PostgREST's null filter on an empty embed is an anti-join. Known
  // acceptance timestamps and legacy NULL timestamps use separate pages so
  // recently accepted legacy rows cannot hide old accepted invoices.
  async function findMissing(legacy: boolean, cursor: string | null): Promise<MissingCandidate[]> {
    const query = createAdminClient().from('invoices')
      .select('id, tenant_id, ksef_number, upo_receipts()')
      .eq('direction', 'outgoing').eq('ksef_status', 'accepted')
      .eq('ksef_environment', environment)
      .not('ksef_number', 'is', null)
      .filter(UPO_EXPECTED, 'eq', 'true')
      .is('upo_receipts', null);
    const filtered = legacy
      ? query.is('ksef_accepted_at', null).lt('created_at', cutoffIso)
        .or(`submitted_to_ksef_at.lt.${cutoffIso},and(submitted_to_ksef_at.is.null,or(updated_at.lt.${cutoffIso},updated_at.is.null))`)
      : query.lt('ksef_accepted_at', cutoffIso);
    if (cursor) filtered.gt('id', cursor);
    const { data, error } = await filtered.order('id', { ascending: true }).limit(MISSING_PAGE_SIZE);
    if (error) throw new Error('Nie można znaleźć zaakceptowanych faktur bez UPO');
    return (data ?? []) as MissingCandidate[];
  }
  let missingNipRejected = 0;
  async function addMissingEvents(candidates: MissingCandidate[], maxEvents: number): Promise<void> {
    for (const candidate of candidates) {
      // Step results can be cached from an earlier run with a larger budget.
      if (events.length >= maxEvents) break;
      const identity = {
        invoiceId: candidate.id,
        tenantId: candidate.tenant_id,
        ksefNumber: candidate.ksef_number,
      };
      try {
        assertUpoIdentity(identity);
      } catch (error) {
        if (!(error instanceof NonRetriableError)) throw error;
        Sentry.captureMessage('UPO retry skipped — malformed missing-receipt identity', { level: 'warning' });
        continue;
      }
      const invoice = await readEligibleMissingInvoice(identity, environment, cutoffIso);
      if (!invoice) continue;
      // UNIQUE(invoice_id) means *any* receipt for this invoice must stop this
      // path, even one carrying a different tenant, number or environment.
      const { data: receipt, error } = await createAdminClient().from('upo_receipts')
        .select('id').eq('invoice_id', identity.invoiceId).maybeSingle();
      if (error) throw new Error('Nie można sprawdzić rekordu UPO faktury');
      if (receipt) continue;
      const tenant = Array.isArray(invoice.tenants) ? invoice.tenants[0] : invoice.tenants;
      // The event NIP controls Inngest throttling. The actual KSeF session
      // comes from tenant credentials, so a changed tenant NIP must be
      // reconciled instead of silently grouping the old invoice under it.
      const nip = invoice.seller_nip?.trim();
      if (!nip || tenant?.nip?.trim() !== nip) {
        missingNipRejected++;
        continue;
      }
      // groupId = NIP: limit „3 naraz per NIP” w pg-boss działa tylko z grupą (AUD-92).
      events.push({ name: 'invoice/upo.requested', groupId: nip, data: { ...identity, nip, environment } });
    }
  }
  async function scanMissing(legacy: boolean, maxEvents: number): Promise<{ scanned: number; truncated: boolean }> {
    let cursor: string | null = null;
    let scanned = 0;
    for (let page = 0; page < MAX_MISSING_SCAN_PAGES && events.length < maxEvents; page++) {
      const stepName = `find-accepted-without-upo${legacy ? '-legacy' : ''}${page ? `-${page}` : ''}`;
      const candidates = await step.run(stepName, () => findMissing(legacy, cursor));
      if (!candidates.length) return { scanned, truncated: false };
      await addMissingEvents(candidates, maxEvents);
      scanned += candidates.length;
      if (events.length >= maxEvents || candidates.length < MISSING_PAGE_SIZE) {
        return { scanned, truncated: false };
      }
      const last = candidates[candidates.length - 1];
      // Cached step results are data, never a safe cursor by themselves.
      try {
        assertJobIdentity(last.id, last.tenant_id);
      } catch (error) {
        if (!(error instanceof NonRetriableError)) throw error;
        return { scanned, truncated: true };
      }
      if (cursor && last.id <= cursor) return { scanned, truncated: true };
      cursor = last.id;
    }
    return { scanned, truncated: events.length < maxEvents };
  }
  const known = await scanMissing(false, MAX_RETRIES_PER_RUN - LEGACY_MISSING_RESERVE);
  const legacy = await scanMissing(true, MAX_RETRIES_PER_RUN);
  const missingCount = known.scanned + legacy.scanned;
  const scanTruncated = known.truncated || legacy.truncated;
  if (missingNipRejected) Sentry.captureMessage('UPO retry skipped — invoice seller NIP requires reconciliation', {
    level: 'warning', extra: { count: missingNipRejected },
  });
  if (scanTruncated) Sentry.captureMessage('UPO retry missing scan truncated — manual reconciliation required', {
    level: 'warning', extra: { knownScanned: known.scanned, legacyScanned: legacy.scanned },
  });
  if (events.length) await step.sendEvent('re-request-upo', events);
  Sentry.addBreadcrumb({ category: 'ksef.upo', level: 'info', message: 'UPO retry batch dispatched',
    data: { stale: stale.length, missing: missingCount, dispatched: events.length,
      quarantined, missingNipRejected, scanTruncated } });
  return { processed: stale.length + missingCount, missing: missingCount,
    dispatched: events.length, quarantined, missingNipRejected, scanTruncated, cutoffIso };
}

