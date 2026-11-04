import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

const s = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('@sentry/nextjs', () => ({ addBreadcrumb: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc: s.rpc }) }));
vi.mock('@/lib/jobs/events', () => ({ inngest: { createFunction: vi.fn() } }));

import { runCleanupAuditLogs } from '@/lib/jobs/runners/cleanup-audit-logs';

/**
 * AUD-79: ponowna dostawa webhooka Stripe porównywała cały payload — pola
 * koperty (`pending_webhooks`) zmieniają się między dostawami.
 * AUD-81 (B9): surowe zdarzenia Stripe 90 dni po przetworzeniu.
 */

const sql = readFileSync('supabase/migrations/00109_stripe_webhook_retention.sql', 'utf8');

describe('webhooki Stripe — porównanie i retencja', () => {
  it('ponowna dostawa: porównanie typu i `data`, nie całego payloadu', () => {
    expect(sql).toContain("v_event.payload->'data' IS DISTINCT FROM p_payload->'data'");
    expect(sql).not.toContain('v_event.payload IS DISTINCT FROM p_payload');
  });

  it('retencja: tylko przetworzone, po 90 dniach, zostaje id i typ', () => {
    expect(sql).toContain("processing_status IN ('processed', 'skipped')");
    expect(sql).toContain("jsonb_build_object('id', id, 'type', type, 'pruned', true)");
    expect(sql).toContain('REVOKE EXECUTE ON FUNCTION public.prune_stripe_webhook_payloads(integer) FROM PUBLIC, anon, authenticated;');
  });

  it('job sprzątania dzienników woła retencję Stripe (90 dni)', async () => {
    // Funkcje paczkowe dzienników (00157) i retencja Stripe: nic do usunięcia.
    s.rpc.mockReset().mockImplementation(async () => ({ data: 0, error: null }));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const ctx = { step: { run: async (_n: string, fn: () => unknown) => fn() }, logger } as unknown as JobContext;

    await runCleanupAuditLogs(ctx);

    expect(s.rpc).toHaveBeenCalledWith('prune_stripe_webhook_payloads', { p_retention_days: 90 });
  });
});
