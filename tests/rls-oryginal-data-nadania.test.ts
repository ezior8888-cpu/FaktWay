import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getRlsTestDatabaseUrl } from './helpers/rls-environment';

/**
 * D-A4-1b-3 PR C (00156): procedura operatora „Brak daty nadania”
 * (`scripts/ops/oryginal-ksef-data-nadania.sql`, wołany przez `.sh` obok) na
 * prawdziwej bazie: prawdziwe wyzwalacze `invoices` (00117, 00119, 00122, 00132)
 * i `audit_logs`.
 *
 * Faktura K zapisana z KSeF decyzją klienta ma `ksef_accepted_at` z
 * `original_check.acquiredAt`, nigdy z `now()` (INV-16). Gdy runner nie zdobył
 * daty, K ma NULL, a strażnik pokazuje I3K (`no_date`). Skrypt uzupełnia datę
 * podaną przez operatora (z Aplikacji Podatnika KSeF), ale tylko:
 *   - na fakturze `accepted` powstałej z tej decyzji
 *     (`fa3_data.import.source = 'ksef_duplicate_decision'`), która jest tą K,
 *     którą pokazuje I3K: sprzedaż z `origin = 'ksef_import'`, na którą wskazuje
 *     `decision.importedInvoiceId` wpisu `number_taken`,
 *   - która nie ma jeszcze daty (raz zapisanej skrypt nie zmienia),
 *   - gdy podany czas jest pełnym czasem ISO 8601 ze strefą, prawdziwą datą
 *     i nie pochodzi z przyszłości;
 * w jednej transakcji: dokładnie jeden zmieniony wiersz i jeden wpis
 * `audit_logs` (`invoice.ksef_accepted_at_backfilled`) albo nic.
 * Bez `--wykonaj` (wykonaj=0) skrypt niczego nie zapisuje.
 *
 * psql: `RLS_TEST_PSQL` (domyślnie `psql`; lokalnie np. `wsl -e psql`).
 */

const hasDatabase = Boolean(process.env.RLS_TEST_DATABASE_URL?.trim());
const databaseUrl = hasDatabase ? getRlsTestDatabaseUrl() : '';
// Jak `.sh`: bez CR (checkout z Windowsa), bo psql nie rozpozna „\if :wykonaj\r”.
const SCRIPT = readFileSync(join(process.cwd(), 'scripts/ops/oryginal-ksef-data-nadania.sql'), 'utf8').split('\r').join('');
const PSQL = (process.env.RLS_TEST_PSQL?.trim() || 'psql').split(/\s+/);

const ORG = '00156d47-0000-4000-8000-000000000001';
const SOURCE = 'scripts/ops/oryginal-ksef-data-nadania.sh';
const ACTION = 'invoice.ksef_accepted_at_backfilled';
const TRIGGER = 'test_oryginal_data_nadania_odmowa';

let boss: PgBoss;
let counter = 0;

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await boss.getDb().executeSql(text, params);
  return rows as T[];
}

/** Skrypt tak, jak uruchamia go `.sh`: `psql -X -q -v id=… -v iso=… -v wykonaj=0|1 -f …` jako postgres. */
function runScript(invoiceId: string, iso: string, wykonaj: boolean): { status: number | null; out: string } {
  const [cmd, ...prefix] = PSQL;
  const result = spawnSync(
    cmd!,
    [...prefix, '-X', '-q', '-v', `id=${invoiceId}`, '-v', `iso=${iso}`, '-v', `wykonaj=${wykonaj ? 1 : 0}`, '-f', '-', databaseUrl],
    { input: SCRIPT, encoding: 'utf8' },
  );
  if (result.error) throw result.error;
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

type InvoiceRow = {
  ksef_status: string;
  ksef_number: string | null;
  ksef_accepted_at: Date | null;
  origin: string;
  fa3_data: Record<string, unknown>;
};

/**
 * Faktura firmy ORG; domyślnie K z decyzji: wychodząca, przyjęta, z importu, bez daty nadania,
 * z wycofanym dokumentem X i wpisem `number_taken`, którego `decision.importedInvoiceId` wskazuje K
 * (tak ją widzi I3K). `linked: false` pomija X i wpis.
 */
async function invoice(state: {
  status?: 'accepted' | 'draft' | 'failed';
  origin?: 'ksef_import' | 'app';
  direction?: 'outgoing' | 'incoming';
  source?: string | null;
  acceptedAt?: string | null;
  number?: string | null;
  linked?: boolean;
} = {}): Promise<string> {
  counter += 1;
  const id = `00156d47-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  const status = state.status ?? 'accepted';
  const source = state.source === undefined ? 'ksef_duplicate_decision' : state.source;
  const ksefNumber = state.number === undefined
    ? (status === 'accepted' ? `9480000014-20261008-0100A0B0C${String(counter).padStart(3, '0')}-1A` : null)
    : state.number;
  await sql(
    `INSERT INTO public.invoices (
       id, tenant_id, direction, origin, internal_number, invoice_type, invoice_kind, issue_date, seller_nip, buyer_nip,
       gross_total, net_total, vat_total, ksef_status, ksef_environment, ksef_number, ksef_accepted_at,
       fa3_data, seller_data, buyer_data)
     VALUES ($1, $2, $9, $3, $4::text, 'VAT', 'regular', '2026-10-08', '9480000014', '1234567890',
       123, 100, 23, $5, 'test', $6, $7::timestamptz,
       CASE WHEN $8::text IS NULL THEN jsonb_build_object('internalNumber', $4::text)
            ELSE jsonb_build_object('internalNumber', $4::text, 'import', jsonb_build_object('source', $8::text)) END,
       '{"nip":"9480000014"}', '{"nip":"1234567890"}')`,
    [id, ORG, state.origin ?? 'ksef_import', `FV/N/${counter}`, status, ksefNumber, state.acceptedAt ?? null, source, state.direction ?? 'outgoing'],
  );
  if (state.linked !== false) await linkRetiredDraft(id, ksefNumber);
  return id;
}

/** Wycofany dokument X (szkic bez numeru) i jego wpis `number_taken` z decyzją, która wskazuje K (`importedInvoiceId`). */
async function linkRetiredDraft(kId: string, ksefNumber: string | null): Promise<void> {
  counter += 1;
  const xId = `00156d47-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  await sql(
    `INSERT INTO public.invoices (
       id, tenant_id, direction, origin, internal_number, invoice_type, invoice_kind, issue_date, seller_nip, buyer_nip,
       gross_total, net_total, vat_total, ksef_status, ksef_environment, fa3_data, seller_data, buyer_data)
     VALUES ($1, $2, 'outgoing', 'app', NULL, 'VAT', 'regular', '2026-10-08', '9480000014', '1234567890',
       123, 100, 23, 'draft', 'test', '{}'::jsonb, '{"nip":"9480000014"}', '{"nip":"1234567890"}')`,
    [xId, ORG],
  );
  await sql(
    `INSERT INTO public.ksef_submissions (tenant_id, invoice_id, submission_type, status, original_ksef_number, original_check)
     VALUES ($1, $2, 'online', 'number_taken', $3,
       jsonb_build_object('reason', 'faktflow-original',
                          'decision', jsonb_build_object('mode', 'import', 'importedInvoiceId', $4::text)))`,
    [ORG, xId, ksefNumber, kId],
  );
}

async function row(id: string): Promise<InvoiceRow> {
  const [r] = await sql<InvoiceRow>(
    'SELECT ksef_status, ksef_number, ksef_accepted_at, origin, fa3_data FROM public.invoices WHERE id = $1',
    [id],
  );
  return r!;
}

async function audits(id: string) {
  return sql<{ action: string; user_id: string | null; entity_type: string; tenant_id: string; details_json: Record<string, unknown> }>(
    'SELECT action, user_id, entity_type, tenant_id, details_json FROM public.audit_logs WHERE entity_id = $1 ORDER BY created_at',
    [id],
  );
}

async function dropFailingAuditTrigger() {
  await sql(`DROP TRIGGER IF EXISTS ${TRIGGER} ON public.audit_logs`);
  await sql(`DROP FUNCTION IF EXISTS public.${TRIGGER}()`);
}

async function cleanup() {
  await dropFailingAuditTrigger();
  // Wyzwalacze historii dostarczenia i szkicu blokują DELETE; to baza testowa, więc rola replica.
  await boss.getDb().executeSql(
    `BEGIN;
     SET LOCAL session_replication_role = replica;
     DELETE FROM public.audit_logs WHERE tenant_id = '${ORG}';
     DELETE FROM public.ksef_submissions WHERE tenant_id = '${ORG}';
     DELETE FROM public.invoices WHERE tenant_id = '${ORG}';
     COMMIT;`,
  );
}

describe.skipIf(!hasDatabase)('D-A4-1b-3 PR C: brak daty nadania, oryginal-ksef-data-nadania.sql (I3K no_date)', () => {
  beforeAll(async () => {
    boss = new PgBoss({ connectionString: databaseUrl, schema: 'pgboss', schedule: false, supervise: false });
    await boss.start();
    await sql(`INSERT INTO public.tenants (id, nip, name) VALUES ($1, '9480000014', 'Firma Brak Daty Nadania') ON CONFLICT (id) DO NOTHING`, [ORG]);
  });

  beforeEach(cleanup);

  afterAll(async () => {
    if (!hasDatabase) return;
    await cleanup();
    await sql('DELETE FROM public.tenants WHERE id = $1', [ORG]);
    await boss.stop({ graceful: false, close: true });
  });

  describe('zapis daty', () => {
    it('podgląd (bez --wykonaj): werdykt TAK, faktura i audyt bez zmian', async () => {
      const id = await invoice();

      const { status, out } = runScript(id, '2026-10-08T12:34:56Z', false);

      expect(status).toBe(0);
      expect(out).toContain('TAK: faktura zapisana z KSeF decyzją klienta');
      expect(out).toContain('Tryb podglądu');
      expect((await row(id)).ksef_accepted_at).toBeNull();
      expect(await audits(id)).toEqual([]);
    });

    it('--wykonaj: ustawia datę z podanego czasu, nic więcej w fakturze nie rusza, jeden wpis audytu z numerem KSeF i podanym czasem', async () => {
      const id = await invoice();
      const before = await row(id);

      const { status, out } = runScript(id, '2026-10-08T12:34:56Z', true);

      expect(status).toBe(0);
      expect(out).toContain('ZAPISANO ksef_accepted_at');
      // Strażnik liczy I3K na bieżąco (bez przebiegu co 5 minut): komunikat tego nie obiecuje.
      expect(out).toContain('I3K „no_date” znika od razu');
      expect(out).not.toContain('następnym przebiegu');
      const after = await row(id);
      expect(after.ksef_accepted_at).toEqual(new Date('2026-10-08T12:34:56Z'));
      expect({ ...after, ksef_accepted_at: null }).toEqual({ ...before, ksef_accepted_at: null });
      const log = await audits(id);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        action: ACTION,
        user_id: null,
        entity_type: 'invoice',
        tenant_id: ORG,
        details_json: {
          ksef_number: before.ksef_number,
          previous_ksef_accepted_at: null,
          given_iso: '2026-10-08T12:34:56Z',
          source: SOURCE,
          runbook: 'ksef-error-codes.md: Brak daty nadania',
        },
      });
      expect(new Date(String(log[0]!.details_json.ksef_accepted_at))).toEqual(new Date('2026-10-08T12:34:56Z'));
    });

    it('czas ze strefą +02:00 to ta sama chwila co w UTC, ułamek sekundy zostaje', async () => {
      const a = await invoice();
      const b = await invoice();

      expect(runScript(a, '2026-10-08T14:34:56+02:00', true).out).toContain('ZAPISANO');
      expect(runScript(b, '2026-10-08T12:34:56.123Z', true).out).toContain('ZAPISANO');

      expect((await row(a)).ksef_accepted_at).toEqual(new Date('2026-10-08T12:34:56Z'));
      expect((await row(b)).ksef_accepted_at).toEqual(new Date('2026-10-08T12:34:56.123Z'));
    });

    it('drugie uruchomienie dla tej samej faktury: NIE (ma już datę), data i audyt bez zmian', async () => {
      const id = await invoice();
      runScript(id, '2026-10-08T12:34:56Z', true);

      const { status, out } = runScript(id, '2026-10-09T08:00:00Z', true);

      expect(status).toBe(0);
      expect(out).toContain('NIE: faktura ma już datę nadania');
      expect((await row(id)).ksef_accepted_at).toEqual(new Date('2026-10-08T12:34:56Z'));
      expect(await audits(id)).toHaveLength(1);
    });

    it('faktura z datą nadania sprzed skryptu (np. z KSeF) → NIE, data zostaje', async () => {
      const id = await invoice({ acceptedAt: '2026-10-07T09:00:00Z' });

      const { out } = runScript(id, '2026-10-08T12:34:56Z', true);

      expect(out).toContain('NIE: faktura ma już datę nadania');
      expect((await row(id)).ksef_accepted_at).toEqual(new Date('2026-10-07T09:00:00Z'));
      expect(await audits(id)).toEqual([]);
    });
  });

  describe('która faktura', () => {
    it.each([
      ['import historii (inne źródło)', { source: 'ksef_history' }],
      ['zwykła faktura z aplikacji (bez klucza import)', { source: null, origin: 'app' as const }],
    ])('%s → NIE, nic nie zmienia', async (_name, state) => {
      const id = await invoice(state);

      const { status, out } = runScript(id, '2026-10-08T12:34:56Z', true);

      expect(status).toBe(0);
      expect(out).toContain('NIE: to nie jest faktura zapisana decyzją przy nierozstrzygniętym 440');
      expect((await row(id)).ksef_accepted_at).toBeNull();
      expect(await audits(id)).toEqual([]);
    });

    it('źródło decyzji, ale żaden wpis number_taken nie wskazuje tej faktury (importedInvoiceId) → NIE, nic nie zmienia', async () => {
      const inna = await invoice();
      const id = await invoice({ linked: false });

      const { status, out } = runScript(id, '2026-10-08T12:34:56Z', true);

      expect(status).toBe(0);
      expect(out).toContain('NIE: to nie jest faktura K, którą pokazuje I3K');
      expect((await row(id)).ksef_accepted_at).toBeNull();
      expect(await audits(id)).toEqual([]);
      // Wpis innej K nie liczy się za tę fakturę, a jej własny zapis działa jak dotąd.
      expect(runScript(inna, '2026-10-08T12:34:56Z', true).out).toContain('ZAPISANO');
      expect((await row(id)).ksef_accepted_at).toBeNull();
    });

    it.each([
      ['faktura z aplikacji (origin app)', { origin: 'app' as const }],
      ['faktura przychodząca (direction incoming)', { direction: 'incoming' as const }],
    ])('%s, choć ma źródło decyzji i wpis wskazujący ją → NIE, nic nie zmienia', async (_name, state) => {
      const id = await invoice(state);

      const { status, out } = runScript(id, '2026-10-08T12:34:56Z', true);

      expect(status).toBe(0);
      expect(out).toContain('NIE: to nie jest faktura K, którą pokazuje I3K');
      expect((await row(id)).ksef_accepted_at).toBeNull();
      expect(await audits(id)).toEqual([]);
    });

    it.each(['draft', 'failed'] as const)('faktura %s (nie przyjęta) → NIE, nic nie zmienia', async (status) => {
      const id = await invoice({ status });

      const { status: code, out } = runScript(id, '2026-10-08T12:34:56Z', true);

      expect(code).toBe(0);
      expect(out).toContain('NIE: faktura nie jest przyjęta');
      expect((await row(id)).ksef_accepted_at).toBeNull();
      expect(await audits(id)).toEqual([]);
    });

    it('nieznane id → NIE: nie ma faktury, kod wyjścia 0', () => {
      const { status, out } = runScript('00156d47-0000-4000-8000-999999999999', '2026-10-08T12:34:56Z', true);

      expect(status).toBe(0);
      expect(out).toContain('NIE: nie ma faktury o tym id');
    });
  });

  describe('podany czas', () => {
    it.each([
      ['sama data', '2026-10-08'],
      ['bez strefy', '2026-10-08T12:34:56'],
      ['spacja zamiast T', '2026-10-08 12:34:56Z'],
      ['bez sekund', '2026-10-08T12:34Z'],
      ['tekst', 'jutro'],
      ['pusty', ''],
      ['cudzysłów i polecenie SQL', "2026-10-08T12:34:56Z'; DELETE FROM public.invoices; --"],
    ])('zły format (%s) → NIE, nic nie zmienia', async (_name, iso) => {
      const id = await invoice();

      const { status, out } = runScript(id, iso, true);

      expect(status).toBe(0);
      expect(out).toContain('NIE: podany czas nie ma postaci pełnego czasu ISO 8601 ze strefą');
      expect((await row(id)).ksef_accepted_at).toBeNull();
      expect(await audits(id)).toEqual([]);
    });

    it.each([
      ['30 lutego', '2026-02-30T10:00:00Z'],
      ['miesiąc 13', '2026-13-01T10:00:00Z'],
      ['godzina 25', '2026-10-08T25:00:00Z'],
    ])('wzorzec pasuje, ale to nie jest prawdziwa data (%s) → NIE zdaniem, nie błędem SQL', async (_name, iso) => {
      const id = await invoice();

      const { status, out } = runScript(id, iso, true);

      expect(status).toBe(0);
      expect(out).toContain('NIE: podany czas nie jest prawdziwą datą');
      expect((await row(id)).ksef_accepted_at).toBeNull();
      expect(await audits(id)).toEqual([]);
    });

    it.each([
      ['rok 2999', () => '2999-01-01T00:00:00Z'],
      ['godzina do przodu', () => new Date(Date.now() + 3_600_000).toISOString()],
    ])('czas z przyszłości (%s) → NIE', async (_name, iso) => {
      const id = await invoice();

      const { status, out } = runScript(id, iso(), true);

      expect(status).toBe(0);
      expect(out).toContain('NIE: podany czas jest z przyszłości');
      expect((await row(id)).ksef_accepted_at).toBeNull();
      expect(await audits(id)).toEqual([]);
    });

    it('czas sprzed minuty (zegar KSeF i bazy mogą się różnić o sekundy) → zapis', async () => {
      const id = await invoice();
      const iso = new Date(Date.now() - 60_000).toISOString();

      expect(runScript(id, iso, true).out).toContain('ZAPISANO');
      expect((await row(id)).ksef_accepted_at).toEqual(new Date(iso));
    });

    it('data w numerze KSeF różni się od podanej o więcej niż dobę: UWAGA, ale zapis nie jest blokowany', async () => {
      const id = await invoice({ number: '9480000014-20261001-0100A0B0C0D0-1A' });

      const { out } = runScript(id, '2026-10-08T12:34:56Z', false);

      expect(out).toContain('UWAGA: data w numerze KSeF');
      expect(out).toContain('TAK: faktura zapisana z KSeF decyzją klienta');
    });

    it('data w numerze KSeF zgodna (także dzień obok, liczona w strefie Warszawy) → bez ostrzeżenia', async () => {
      const id = await invoice({ number: '9480000014-20261010-0100A0B0C0D0-1A' });

      // 2026-10-08T22:30:00Z to już 9 października w Warszawie: do 10.10 jest doba, nie dwie.
      const { out } = runScript(id, '2026-10-08T22:30:00Z', false);

      expect(out).not.toContain('UWAGA');
      expect(out).toContain('TAK: faktura zapisana z KSeF decyzją klienta');
    });
  });

  describe('jedna transakcja', () => {
    it('odmowa zapisu audytu cofa też datę (psql kończy się błędem, faktura bez zmian)', async () => {
      const id = await invoice();
      await sql(
        `CREATE FUNCTION public.${TRIGGER}() RETURNS trigger LANGUAGE plpgsql AS $f$
         BEGIN RAISE EXCEPTION 'test: audyt odrzucony'; END $f$`,
      );
      await sql(
        `CREATE TRIGGER ${TRIGGER} BEFORE INSERT ON public.audit_logs FOR EACH ROW
         WHEN (NEW.tenant_id = '${ORG}' AND NEW.action = '${ACTION}')
         EXECUTE FUNCTION public.${TRIGGER}()`,
      );
      try {
        const { status, out } = runScript(id, '2026-10-08T12:34:56Z', true);

        expect(status).not.toBe(0);
        expect(out).toContain('test: audyt odrzucony');
        expect(out).not.toContain('ZAPISANO');
        expect((await row(id)).ksef_accepted_at).toBeNull();
        expect(await audits(id)).toEqual([]);
      } finally {
        await dropFailingAuditTrigger();
      }
    });
  });
});
