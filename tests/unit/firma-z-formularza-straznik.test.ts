import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Strażnik UX-01 (WZR-02 / MOD-S01): każda akcja, która z danych formularza
 * tworzy NOWY dokument (szkic albo „Wystaw i wyślij”), musi przyjąć
 * `expectedTenantId` i przekazać go do `requireUserAndActiveOrg`, które
 * porównuje go z firmą z ciasteczka. Zachowanie sprawdza
 * `firma-z-formularza.test.ts`; ten test pilnuje, żeby nowa akcja nie ominęła
 * reguły po cichu.
 *
 * Każda eksportowana akcja w `components/invoices/*actions*.ts` musi być
 * sklasyfikowana: na liście wystawiania albo na liście wyjątków z powodem.
 * Nowa akcja spoza obu list wywala test — trzeba świadomie zdecydować.
 * To samo dla plików w `app/`, `components/`, `lib/`, które zapisują
 * dokument albo zlecają wysyłkę (`ISSUING_FILES` / `EXEMPT_FILES` niżej;
 * wzorce, po których skan je rozpoznaje — `writesDocument`).
 */

const DIR = join(process.cwd(), 'components', 'invoices');

/** Akcje tworzące dokument z formularza — firma formularza musi zgadzać się z firmą z ciasteczka. */
const ISSUING: Record<string, string[]> = {
  'actions.ts': ['saveDraftAction', 'saveAndSendInvoiceAction'],
  'advance-actions.ts': ['saveAdvanceAction', 'saveAndSendAdvanceAction'],
  'final-actions.ts': ['saveFinalAction', 'saveAndSendFinalAction'],
  'correction-actions.ts': ['saveCorrectionDraftAction', 'saveAndSendCorrectionAction'],
};

/**
 * Akcje bez kontroli firmy formularza. Powód musi tłumaczyć, czemu pomylenie
 * firm nie wystawi dokumentu za inną firmę.
 */
const ID_BOUND = 'działa na istniejącym dokumencie wskazanym id; zapytanie filtruje tenant_id firmy z sesji, więc dokument innej firmy to „nie znaleziono”';
const EXEMPT: Record<string, string> = {
  lookupBuyerAction: 'odczyt nabywcy z bazy kontrahentów albo GUS; zapisuje tylko podpowiedź kontrahenta, nie dokument',
  prefillFromLastInvoiceAction: 'tylko odczyt podkładu formularza; nic nie zapisuje',
  prefillFromInvoiceAction: 'tylko odczyt podkładu formularza; nic nie zapisuje',
  getCorrectionParentContextAction: 'tylko odczyt faktury pierwotnej korekty; zapis korekty sprawdza firmę formularza',
  downloadInvoiceXmlAction: ID_BOUND,
  resendInvoiceAction: ID_BOUND,
  resetInvoiceToDraftAction: ID_BOUND,
  decideKsefDuplicateAction: ID_BOUND,
  emailInvoiceAction: ID_BOUND,
  sendDraftInvoiceAction: ID_BOUND,
  deleteDraftInvoiceAction: ID_BOUND,
};

/** Pliki akcji wystawiania — ich akcje sprawdzają testy niżej, akcja po akcji. */
const ISSUING_FILES = Object.keys(ISSUING).map((file) => `components/invoices/${file}`);

/**
 * Pliki z zapisem dokumentu albo zleceniem wysyłki (wg `writesDocument`), które
 * nie wystawiają dokumentu z formularza faktury. Powód mówi, czemu — i skąd
 * plik bierze firmę.
 */
const EXEMPT_FILES: Record<string, string> = {
  'components/invoices/actions-detail.ts': 'akcje na istniejącym dokumencie wskazanym id (ponowienie, reset, duplikat, e-mail, XML) — patrz EXEMPT',
  'components/invoices/draft-actions.ts': 'wysyłka i usunięcie istniejącego szkicu wskazanego id — patrz EXEMPT',
  'lib/invoices/ksef-submit-enqueue.ts': 'definicja zlecenia wysyłki; firmę podaje wołający (akcja albo job)',
  'lib/ksef/offline-queue.ts': 'kolejka offline wysyłki (ksef_offline_queue); firmę podaje wołający',
  'lib/ksef/submission-log.ts': 'dziennik prób wysyłki (ksef_submissions); firmę podaje wołający',
  'lib/import/import-engine.ts': 'import dokumentów w jobach (plik, historia KSeF); firma z danych joba',
  'lib/jobs/runners/inbox-polling.ts': 'job: zapis faktur odebranych z KSeF; firma z danych joba',
  'lib/jobs/runners/auto-categorize-inbox.ts': 'job: koszt z faktury odebranej (expenses); firma z danych joba',
  'lib/flo/functions/payment-confirm.ts': 'potwierdzenie wpłaty (payments); firma z zapisanej propozycji',
  'app/actions/recurring-invoices.ts': 'harmonogram faktur cyklicznych (recurring_invoices); z invoices tylko odczyt szablonu',
  'app/actions/reminders.ts': 'przypomnienie o płatności (flo_proposals); z invoices tylko odczyt',
  'app/actions/expenses.ts': 'koszt ze zdjęcia (ocr_jobs, expenses); z invoices tylko odczyt waluty',
  'lib/billing/self-invoice.ts': 'faktura za abonament (RPC create_billing_vat_invoice); firma klienta z płatności Stripe, sprzedawca z konfiguracji operatora',
  'lib/jobs/runners/self-invoice-payment.ts': 'job: wysyłka faktury za abonament; firma z danych płatności',
  'lib/ksef/duplicate-decision-rpc.ts': 'decyzja o duplikacie istniejącego dokumentu wskazanego id (RPC decide_ksef_duplicate*); firmę podaje wołający — decideKsefDuplicateAction albo operator',
  'lib/invoices/ksef-requeue-event.ts': 'definicja zdarzenia ponowienia wysyłki; firma z wiersza faktury',
  'lib/jobs/runners/ksef-lifecycle-reconcile.ts': 'job: domykanie cyklu wysyłki; firma z wiersza faktury',
  'app/admin/ksef/actions.ts': 'operator w /admin: ponowienie wysyłki i decyzja o duplikacie istniejącego dokumentu; firma z wiersza faktury',
  'lib/jobs/runners/bulk-import.ts': 'job: import z pliku (silnik importu); firma z danych joba',
  'lib/jobs/runners/ksef-history-sync.ts': 'job: pobranie historii z KSeF (silnik importu); firma z danych joba',
};

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');

/**
 * Funkcje SQL, które wstawiają wiersz do `invoices` — wprost albo przez inną
 * taką funkcję — wg ostatniej definicji w migracjach. Wywołanie `.rpc('<nazwa>'`
 * to zapis dokumentu tak samo jak `.from('invoices').insert(`, więc nowa
 * funkcja tworząca faktury trafia do skanu bez ręcznej listy.
 */
function invoiceInsertingRpcs(): Set<string> {
  const bodies = new Map<string, string>();
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    for (const m of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?(\w+)\s*\(/gi)) {
      const rest = sql.slice(m.index!);
      const open = /\bAS\s+(\$\w*\$)/i.exec(rest);
      if (!open) continue;
      const start = open.index + open[0].length;
      const end = rest.indexOf(open[1]!, start);
      if (end > start) bodies.set(m[1]!.toLowerCase(), rest.slice(start, end));
    }
  }
  const inserting = new Set(
    [...bodies].filter(([, body]) => /\bINSERT\s+INTO\s+(?:public\.)?invoices\b/i.test(body)).map(([name]) => name),
  );
  // Domknięcie: funkcja wołająca funkcję, która wstawia fakturę, też ją wstawia.
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, body] of bodies) {
      if (!inserting.has(name) && [...inserting].some((callee) => new RegExp(`\\b${callee}\\s*\\(`, 'i').test(body))) {
        inserting.add(name);
        grew = true;
      }
    }
  }
  return inserting;
}

const INVOICE_RPCS = invoiceInsertingRpcs();

/**
 * Zapis dokumentu albo zlecenie wysyłki w kodzie aplikacji:
 * - `.from('invoices')` i `.insert(`/`.upsert(` w jednym pliku — celowo szeroko
 *   (nie wymaga jednego łańcucha): zapis przez zmienną pośrednią też się liczy,
 *   a nadmiar kosztuje tylko wiersz na liście wyjątków;
 * - `.rpc('<funkcja wstawiająca faktury>'` (`INVOICE_RPCS`);
 * - zlecenie wysyłki: `enqueueKsefSubmitAfterDraft(`, `buildKsefRequeueEvent(`,
 *   `invoiceSubmitRequested.create(`;
 * - wywołanie silnika importu: `processImportedInvoices(`, `processImportedInvoicesDetailed(`.
 */
function writesDocument(source: string): boolean {
  const touchesInvoices = /\.from\(\s*['"]invoices['"]\s*\)/.test(source) && /\.(?:insert|upsert)\(/.test(source);
  const callsInvoiceRpc = [...source.matchAll(/\.rpc\(\s*['"](\w+)['"]/g)]
    .some((m) => INVOICE_RPCS.has(m[1]!.toLowerCase()));
  const queuesSend = /\b(?:enqueueKsefSubmitAfterDraft|buildKsefRequeueEvent)\(|\binvoiceSubmitRequested\.create\(/.test(source);
  const runsImport = /\bprocessImportedInvoices(?:Detailed)?\(/.test(source);
  return touchesInvoices || callsInvoiceRpc || queuesSend || runsImport;
}

/** Pliki `.ts`/`.tsx` w `app/`, `components/`, `lib/`, które `writesDocument`. */
function documentWriters(): string[] {
  return ['app', 'components', 'lib'].flatMap((root) =>
    (readdirSync(join(process.cwd(), root), { recursive: true }) as string[])
      .map((rel) => `${root}/${rel.split('\\').join('/')}`)
      .filter((file) => /\.tsx?$/.test(file))
      .filter((file) => writesDocument(readFileSync(join(process.cwd(), file), 'utf8'))),
  ).sort();
}

interface ExportedAction {
  file: string;
  name: string;
  params: string;
  /** Tekst od deklaracji do następnego eksportu — sygnatura i ciało. */
  text: string;
}

/** Zawartość nawiasów od `open` (indeks znaku `(`), z zagnieżdżeniami. */
function balancedParens(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++;
    if (source[i] === ')' && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error('niedomknięty nawias');
}

function exportedActions(): ExportedAction[] {
  const files = readdirSync(DIR).filter((f) => /actions.*\.ts$/.test(f) || /-actions\.ts$/.test(f));
  return files.flatMap((file) => {
    const source = readFileSync(join(DIR, file), 'utf8');
    const starts = [...source.matchAll(/^export async function (\w+)\s*\(/gm)];
    const nextExports = [...source.matchAll(/^export /gm)].map((m) => m.index!);
    return starts.map((m) => {
      const start = m.index!;
      const end = nextExports.find((i) => i > start) ?? source.length;
      return {
        file,
        name: m[1]!,
        params: balancedParens(source, start + m[0].length - 1),
        text: source.slice(start, end),
      };
    });
  });
}

const actions = exportedActions();
const issuing = actions.filter((a) => ISSUING[a.file]?.includes(a.name));

describe('UX-01 strażnik: akcje wystawiania sprawdzają firmę formularza', () => {
  it('skan widzi pliki akcji i wszystkie akcje wystawiania', () => {
    expect(actions.length).toBeGreaterThan(10);
    expect(issuing.map((a) => a.name).sort()).toEqual(Object.values(ISSUING).flat().sort());
  });

  it('każda eksportowana akcja jest sklasyfikowana (wystawianie albo wyjątek z powodem)', () => {
    const unclassified = actions
      .filter((a) => !ISSUING[a.file]?.includes(a.name) && !(a.name in EXEMPT))
      .map((a) => `${a.file}: ${a.name}`);
    expect(unclassified).toEqual([]);
  });

  it('lista wyjątków nie ma martwych wpisów', () => {
    const names = new Set(actions.map((a) => a.name));
    expect(Object.keys(EXEMPT).filter((n) => !names.has(n))).toEqual([]);
  });

  it.each(issuing.map((a) => [`${a.file}: ${a.name}`, a] as const))(
    '%s przyjmuje expectedTenantId i przekazuje go do kontroli firmy',
    (_label, action) => {
      expect(action.params).toMatch(/\bexpectedTenantId\b/);
      const source = readFileSync(join(DIR, action.file), 'utf8');
      const direct = /requireUserAndActiveOrg\(\s*\{\s*expectedTenantId\s*\}\s*\)/.test(action.text);
      const viaHelper = action.text.match(/\b(\w*[tT]enantContext)\(\s*\{\s*expectedTenantId\s*\}\s*\)/);
      expect(direct || viaHelper, 'akcja musi wołać kontekst firmy z { expectedTenantId }').toBeTruthy();
      if (!direct && viaHelper) {
        // Pomocnik pliku przekazuje parametr dalej, a nie gubi go po drodze.
        const helper = new RegExp(
          `async function ${viaHelper[1]}\\(\\s*(\\w+)\\??:[\\s\\S]*?requireUserAndActiveOrg\\(\\s*\\1\\s*\\)`,
        );
        expect(source).toMatch(helper);
      }
    },
  );

  it('każda akcja wystawiania ma wiersz w tabeli ISSUE_PATHS testu zachowania (ciasteczko ≠ firma formularza)', () => {
    const behaviour = readFileSync(join(process.cwd(), 'tests', 'unit', 'firma-z-formularza.test.ts'), 'utf8');
    // Tylko tabela — wywołania poza nią (ścieżki szczęśliwe) nie zastępują wiersza.
    const table = behaviour.match(/const ISSUE_PATHS[\s\S]*?\r?\n\];/)?.[0] ?? '';
    expect(table).not.toBe('');
    const missing = issuing.map((a) => a.name).filter((n) => !new RegExp(`\\b${n}\\(`).test(table));
    expect(missing).toEqual([]);
  });

  describe('pliki z zapisem dokumentu w app/, components/, lib/', () => {
    const writers = documentWriters();

    it('skan widzi pliki akcji wystawiania', () => {
      expect(ISSUING_FILES.filter((f) => !writers.includes(f))).toEqual([]);
    });

    it('skan migracji rozpoznaje funkcje SQL tworzące faktury (wprost i przez rdzeń)', () => {
      // Znane dziś: faktura za abonament (00152) i decyzja o duplikacie (00156).
      // Pusty wynik albo brak któregoś = zepsuty odczyt migracji, nie „brak zapisów”.
      for (const name of ['create_billing_vat_invoice', 'ksef_duplicate_decide_core', 'decide_ksef_duplicate', 'decide_ksef_duplicate_original']) {
        expect(INVOICE_RPCS, name).toContain(name);
      }
    });

    it('każdy plik z zapisem dokumentu jest sklasyfikowany (wystawianie albo wyjątek z powodem)', () => {
      const unclassified = writers.filter((f) => !ISSUING_FILES.includes(f) && !(f in EXEMPT_FILES));
      expect(unclassified).toEqual([]);
    });

    it('lista wyjątków plików nie ma martwych wpisów ani pustych powodów', () => {
      expect(Object.keys(EXEMPT_FILES).filter((f) => !writers.includes(f))).toEqual([]);
      expect(Object.entries(EXEMPT_FILES).filter(([, why]) => why.trim().length < 20).map(([f]) => f)).toEqual([]);
    });
  });

  it('formularze odsyłają firmę strony: każde wywołanie akcji wystawiania ma tenantId jako drugi argument', () => {
    const names = Object.values(ISSUING).flat();
    const forms = ['invoice-form.tsx', 'advance-form.tsx', 'final-form.tsx', 'correction-form.tsx'];
    const calls = forms.flatMap((file) => {
      const source = readFileSync(join(DIR, file), 'utf8');
      return [...source.matchAll(new RegExp(`\\b(${names.join('|')})\\(`, 'g'))].map((m) => ({
        call: `${file}: ${m[1]}`,
        args: balancedParens(source, m.index! + m[0].length - 1),
      }));
    });
    // Każdy formularz woła swoje dwie akcje (szkic i wyślij).
    expect(calls).toHaveLength(names.length);
    expect(calls.filter((c) => !/,\s*tenantId\s*$/.test(c.args)).map((c) => c.call)).toEqual([]);
  });
});
