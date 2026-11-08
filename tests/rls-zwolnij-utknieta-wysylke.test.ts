import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ENQUEUE_LOST_MESSAGE } from '@/lib/jobs/runners/ksef-lifecycle-reconcile';

import { getRlsTestDatabaseUrl } from './helpers/rls-environment';

/**
 * A5 — procedura operatora dla faktury, która utknęła w wysyłce
 * (`scripts/ops/zwolnij-utknieta-wysylke.sql`, wołany przez `.sh` obok),
 * na prawdziwej bazie: prawdziwe RPC (`release_ksef_enqueue`,
 * `ksef_send_audit`, `ksef_has_contact_evidence`), wyzwalacze, pg-boss.
 *
 *   I2 (`sending` ponad 30 min albo bez znacznika przejęcia) — dziś bez
 *   wyjścia: automat tylko alarmuje, a RPC operatora przyjmują wyłącznie
 *   failed/rejected. Zwolnienie → failed RESULT_UNCERTAIN, przejęcie zdjęte,
 *   audyt; dalej panel `/admin/ksef` (uzgodnienie albo ponowienie).
 *   I1 (`queued` ponad 15 min) — to samo co cron cyklu życia (szkic albo
 *   ENQUEUE_LOST), dla sytuacji, gdy cron nie działa.
 *   Żywe zlecenie w pg-boss (created/retry/active) = nic nie zmieniamy.
 *   Bez `--wykonaj` (wykonaj=0) skrypt niczego nie zapisuje.
 *
 * psql: `RLS_TEST_PSQL` (domyślnie `psql`; lokalnie np. `wsl -e psql`).
 */

const hasDatabase = Boolean(process.env.RLS_TEST_DATABASE_URL?.trim());
const databaseUrl = hasDatabase ? getRlsTestDatabaseUrl() : '';
// Jak `.sh`: bez CR (checkout z Windowsa) — psql nie rozpozna „\if :wykonaj\r”.
const SCRIPT = readFileSync(join(process.cwd(), 'scripts/ops/zwolnij-utknieta-wysylke.sql'), 'utf8').split('\r').join('');
const PSQL = (process.env.RLS_TEST_PSQL?.trim() || 'psql').split(/\s+/);

const ORG = 'a5d20000-0000-4000-8000-000000000000';
const QUEUE = 'invoice.submit.requested';
const SOURCE = 'scripts/ops/zwolnij-utknieta-wysylke.sh';

let boss: PgBoss;
let counter = 0;

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await boss.getDb().executeSql(text, params);
  return rows as T[];
}

/** Skrypt tak, jak uruchamia go `.sh`: `psql -X -q -v id=… -v wykonaj=0|1 -f …` jako postgres. */
function runScript(invoiceId: string, wykonaj: boolean): { status: number | null; out: string } {
  const [cmd, ...prefix] = PSQL;
  const result = spawnSync(
    cmd!,
    [...prefix, '-X', '-q', '-v', `id=${invoiceId}`, '-v', `wykonaj=${wykonaj ? 1 : 0}`, '-f', '-', databaseUrl],
    { input: SCRIPT, encoding: 'utf8' },
  );
  if (result.error) throw result.error;
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

type InvoiceRow = {
  ksef_status: string;
  last_error_code: string | null;
  last_error: string | null;
  ksef_send_owner: string | null;
  submitted_to_ksef_at: Date | null;
};

/** Faktura wychodząca firmy ORG; minuty wstecz dla znacznika przejęcia i ostatniej zmiany. */
async function invoice(state: {
  status: 'sending' | 'queued' | 'failed' | 'accepted';
  claimedMinutesAgo?: number | null;
  updatedMinutesAgo?: number;
  owner?: string | null;
  code?: string | null;
  ksefNumber?: string | null;
}): Promise<string> {
  counter += 1;
  const id = `a5d20000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  const number = `I2/${counter}`;
  await sql(
    `INSERT INTO public.invoices (
       id, tenant_id, direction, internal_number, invoice_type, invoice_kind, issue_date, seller_nip, buyer_nip,
       gross_total, net_total, vat_total, ksef_status, ksef_environment, last_error_code, ksef_number,
       fa3_data, seller_data, buyer_data, ksef_send_owner, submitted_to_ksef_at, updated_at)
     VALUES ($1, $2, 'outgoing', $3::text, 'VAT', 'regular', '2026-10-14', '9480000014', '1234567890',
       123, 100, 23, $4, 'test', $5, $6,
       jsonb_build_object('internalNumber', $3::text, 'type', 'VAT'), '{"nip":"9480000014"}', '{"nip":"1234567890"}',
       $7, CASE WHEN $8::int IS NULL THEN NULL ELSE now() - make_interval(mins => $8::int) END,
       now() - make_interval(mins => $9::int))`,
    [id, ORG, number, state.status, state.code ?? null, state.ksefNumber ?? null,
      state.owner === undefined ? `attempt-${counter}` : state.owner,
      state.claimedMinutesAgo === undefined ? 45 : state.claimedMinutesAgo,
      state.updatedMinutesAgo ?? 45],
  );
  return id;
}

async function row(id: string): Promise<InvoiceRow> {
  const [r] = await sql<InvoiceRow>(
    'SELECT ksef_status, last_error_code, last_error, ksef_send_owner, submitted_to_ksef_at FROM public.invoices WHERE id = $1',
    [id],
  );
  return r!;
}

async function audits(id: string) {
  return sql<{ action: string; user_id: string | null; details_json: Record<string, unknown> }>(
    'SELECT action, user_id, details_json FROM public.audit_logs WHERE entity_id = $1 ORDER BY created_at',
    [id],
  );
}

/** Wpis historii wysyłki (dowód kontaktu z KSeF dla intent/sent/accepted/duplicate). */
async function submission(invoiceId: string, status: 'intent' | 'sent' | 'abandoned') {
  await sql(
    `INSERT INTO public.ksef_submissions (tenant_id, invoice_id, submission_type, status, session_reference_number, invoice_reference_number)
     VALUES ($1, $2, 'online', $3, $4, $5)`,
    [ORG, invoiceId, status, `SES-I2-${counter}`, status === 'sent' ? `REF-I2-${counter}` : null],
  );
}

/** Zlecenie wysyłki tej faktury w pg-boss w zadanym stanie (stan ustawiany wprost — bez pobierania cudzych zleceń). */
async function job(invoiceId: string, state: 'created' | 'retry' | 'active' | 'completed' | 'failed') {
  const id = await boss.send(QUEUE, { invoiceId, tenantId: ORG, sendAttemptId: `attempt-job-${counter}` });
  if (!id) throw new Error('pg-boss nie utworzył zlecenia');
  if (state !== 'created') {
    await sql(`UPDATE pgboss.job SET state = $2::pgboss.job_state, started_on = now() WHERE name = $3 AND id = $1`, [id, state, QUEUE]);
  }
  return id;
}

async function cleanup() {
  // Wyzwalacze historii dostarczenia i szkicu blokują DELETE — baza testowa, rola replica.
  await sql(`DELETE FROM pgboss.job WHERE name = '${QUEUE}' AND data->>'tenantId' = '${ORG}'`);
  await boss.getDb().executeSql(
    `BEGIN;
     SET LOCAL session_replication_role = replica;
     DELETE FROM public.audit_logs WHERE tenant_id = '${ORG}';
     DELETE FROM public.ksef_submissions WHERE tenant_id = '${ORG}';
     DELETE FROM public.invoices WHERE tenant_id = '${ORG}';
     COMMIT;`,
  );
}

describe.skipIf(!hasDatabase)('A5: faktura utknęła w wysyłce — zwolnij-utknieta-wysylke.sql (I2/I1)', () => {
  beforeAll(async () => {
    boss = new PgBoss({ connectionString: databaseUrl, schema: 'pgboss', schedule: false, supervise: false });
    await boss.start();
    await boss.createQueue(QUEUE);
    await sql(`INSERT INTO public.tenants (id, nip, name) VALUES ($1, '9480000014', 'Firma Utknięta Wysyłka') ON CONFLICT (id) DO NOTHING`, [ORG]);
  });

  beforeEach(cleanup);

  afterAll(async () => {
    if (!hasDatabase) return;
    await cleanup();
    await sql('DELETE FROM public.tenants WHERE id = $1', [ORG]);
    await boss.stop({ graceful: false, close: true });
  });

  describe('I2 — sending bez wyjścia', () => {
    it('podgląd (bez --wykonaj): werdykt TAK (I2), faktura i audyt bez zmian', async () => {
      const id = await invoice({ status: 'sending', claimedMinutesAgo: 45 });

      const { status, out } = runScript(id, false);

      expect(status).toBe(0);
      expect(out).toContain('TAK (I2)');
      expect(out).toContain('Tryb podglądu');
      expect(await row(id)).toMatchObject({ ksef_status: 'sending', ksef_send_owner: expect.stringMatching(/^attempt-/) });
      expect(await audits(id)).toEqual([]);
    });

    it('--wykonaj: failed RESULT_UNCERTAIN, przejęcie zdjęte, znacznik zostaje, audyt z poprzednim właścicielem; panel: „Wyślij ponownie”', async () => {
      const id = await invoice({ status: 'sending', claimedMinutesAgo: 45, owner: 'attempt-zawieszona' });
      const before = await row(id);

      const { status, out } = runScript(id, true);

      expect(status).toBe(0);
      expect(out).toContain('ZWOLNIONO (I2)');
      expect(out).toContain(`/admin/ksef/${id} → „Wyślij ponownie”`);
      const after = await row(id);
      expect(after).toMatchObject({ ksef_status: 'failed', last_error_code: 'RESULT_UNCERTAIN', ksef_send_owner: null });
      expect(after.last_error).toMatch(/przerwana bez wyniku \(I2\)/);
      expect(after.submitted_to_ksef_at).toEqual(before.submitted_to_ksef_at);
      const log = await audits(id);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        action: 'invoice.send_lease_released',
        user_id: null,
        details_json: {
          invariant: 'I2', code: 'RESULT_UNCERTAIN', previous_owner: 'attempt-zawieszona',
          contact_evidence: false, open_submission: false, source: SOURCE,
        },
      });
    });

    it('bez znacznika przejęcia (submitted_to_ksef_at NULL) — też I2', async () => {
      const id = await invoice({ status: 'sending', claimedMinutesAgo: null, owner: null });

      expect(runScript(id, true).out).toContain('ZWOLNIONO (I2)');
      expect(await row(id)).toMatchObject({ ksef_status: 'failed', last_error_code: 'RESULT_UNCERTAIN' });
    });

    it('otwarty zamiar (intent): dowód kontaktu w audycie, panel: „Tylko uzgodnij”', async () => {
      const id = await invoice({ status: 'sending', claimedMinutesAgo: 120 });
      await submission(id, 'intent');

      const { out } = runScript(id, true);

      expect(out).toContain(`/admin/ksef/${id} → „Tylko uzgodnij”`);
      expect((await audits(id))[0]?.details_json).toMatchObject({ contact_evidence: true, open_submission: true });
    });

    it('przejęta 20 min temu (dzierżawa + zapas jeszcze trwa) → NIE, nic nie zmienia', async () => {
      const id = await invoice({ status: 'sending', claimedMinutesAgo: 20 });

      const { status, out } = runScript(id, true);

      expect(status).toBe(0);
      expect(out).toContain('NIE: faktura nie jest w I2');
      expect(await row(id)).toMatchObject({ ksef_status: 'sending' });
      expect(await audits(id)).toEqual([]);
    });

    it.each(['created', 'retry', 'active'] as const)('żywe zlecenie w pg-boss (%s) → NIE, nic nie zmienia', async (state) => {
      const id = await invoice({ status: 'sending', claimedMinutesAgo: 45 });
      await job(id, state);

      const { out } = runScript(id, true);

      expect(out).toContain('NIE: w pg-boss żyje zlecenie');
      expect(out).toContain(state);
      expect(await row(id)).toMatchObject({ ksef_status: 'sending' });
      expect(await audits(id)).toEqual([]);
    });

    it('zakończone zlecenie (completed/failed) nie blokuje zwolnienia', async () => {
      const id = await invoice({ status: 'sending', claimedMinutesAgo: 45 });
      await job(id, 'completed');
      await job(id, 'failed');

      expect(runScript(id, true).out).toContain('ZWOLNIONO (I2)');
    });

    it('zwolnioną fakturę przyjmują RPC operatora: requeue_ksef_send (Wyślij ponownie) przechodzi do queued', async () => {
      const id = await invoice({ status: 'sending', claimedMinutesAgo: 45 });
      runScript(id, true);

      const [requeued] = await sql<{ ksef_status: string }>(
        `SELECT (public.requeue_ksef_send($1, $2, 'operator-attempt-1', NULL, false)).ksef_status`, [id, ORG],
      );
      expect(requeued).toEqual({ ksef_status: 'queued' });
      expect(await row(id)).toMatchObject({ ksef_status: 'queued' });
    });
  });

  describe('I1 — queued bez zlecenia (to samo co cron)', () => {
    it('bez dowodu kontaktu → szkic przez release_ksef_enqueue, audyt invoice.enqueue_released z powodem', async () => {
      const id = await invoice({ status: 'queued', claimedMinutesAgo: null, updatedMinutesAgo: 20 });

      const { status, out } = runScript(id, true);

      expect(status).toBe(0);
      expect(out).toContain('ZWOLNIONO (I1): faktura wróciła do szkicu');
      expect(await row(id)).toMatchObject({ ksef_status: 'draft', ksef_send_owner: null, submitted_to_ksef_at: null });
      expect(await audits(id)).toEqual([
        expect.objectContaining({ action: 'invoice.enqueue_released', details_json: { reason: `operator: ${SOURCE} (I1)` } }),
      ]);
    });

    it('z dowodem kontaktu (wpis sent) → failed ENQUEUE_LOST z tekstem crona, audyt invoice.enqueue_lost', async () => {
      const id = await invoice({ status: 'queued', claimedMinutesAgo: null, updatedMinutesAgo: 20 });
      await submission(id, 'sent');

      const { out } = runScript(id, true);

      expect(out).toContain('ZWOLNIONO (I1): failed ENQUEUE_LOST');
      expect(await row(id)).toMatchObject({
        ksef_status: 'failed', last_error_code: 'ENQUEUE_LOST', last_error: ENQUEUE_LOST_MESSAGE, ksef_send_owner: null,
      });
      expect(await audits(id)).toEqual([
        expect.objectContaining({
          action: 'invoice.enqueue_lost',
          details_json: { invariant: 'I1', code: 'ENQUEUE_LOST', contact_evidence: true, open_submission: true, source: SOURCE },
        }),
      ]);
    });

    it('queued od 5 min → NIE (cron ma jeszcze czas)', async () => {
      const id = await invoice({ status: 'queued', claimedMinutesAgo: null, updatedMinutesAgo: 5 });

      expect(runScript(id, true).out).toContain('NIE: faktura nie jest w I2');
      expect(await row(id)).toMatchObject({ ksef_status: 'queued' });
    });

    it('queued ze zleceniem w pg-boss → NIE', async () => {
      const id = await invoice({ status: 'queued', claimedMinutesAgo: null, updatedMinutesAgo: 20 });
      await job(id, 'created');

      expect(runScript(id, true).out).toContain('NIE: w pg-boss żyje zlecenie');
      expect(await row(id)).toMatchObject({ ksef_status: 'queued' });
    });
  });

  describe('inne stany i błędne wejście', () => {
    it.each(['failed', 'accepted'] as const)('faktura %s → NIE, nic nie zmienia', async (status) => {
      const id = await invoice({
        status, claimedMinutesAgo: 45, code: status === 'failed' ? 'RESULT_UNCERTAIN' : null,
        ksefNumber: status === 'accepted' ? '9480000014-20261014-0100A0B0C0D0-1A' : null, owner: null,
      });

      expect(runScript(id, true).out).toContain('NIE: faktura nie jest w I2');
      expect(await row(id)).toMatchObject({ ksef_status: status });
      expect(await audits(id)).toEqual([]);
    });

    it('nieznane id → NIE: nie ma faktury, kod wyjścia 0', () => {
      const { status, out } = runScript('a5d20000-0000-4000-8000-999999999999', true);

      expect(status).toBe(0);
      expect(out).toContain('NIE: nie ma faktury o tym id');
    });
  });
});
