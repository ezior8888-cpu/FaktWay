import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Skrypty operatora BLIK-a w scripts/ops. Część wykonywana w kontenerze aplikacji
 * (blok `node` w heredoc) idzie naprawdę: ten sam kod, z `fetch` podmienionym na
 * zaprogramowane odpowiedzi Stripe. Cała ścieżka z argumentem przez powłokę idzie
 * z atrapami `ssh` i `docker`, bo skryptu nie wolno sprawdzać na produkcji.
 */

const CHECK = 'scripts/ops/stripe-blik-sprawdz.sh';
const EXPIRE = 'scripts/ops/stripe-blik-wygas-sesje.sh';
const WARTOSC_KLUCZA = 'wartosc-klucza-w-tescie';

interface Route {
  method?: 'GET' | 'POST';
  match: string;
  status?: number;
  body: unknown;
}

interface Call {
  url: string;
  method: string;
  version?: string;
}

const PRELOAD = `
import { appendFileSync } from 'node:fs';
const routes = JSON.parse(process.env.TEST_ROUTES);
globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? 'GET';
  appendFileSync(process.env.TEST_CALLS, JSON.stringify({
    url: String(url), method, version: init.headers?.['Stripe-Version'],
  }) + '\\n');
  const route = routes.find((r) => (r.method ?? 'GET') === method && String(url).includes(r.match));
  if (!route) {
    return new Response(JSON.stringify({ error: { message: 'brak trasy w teście: ' + url } }), { status: 500 });
  }
  return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
};
`;

function runContainerPart(script: string, routes: Route[], env: Record<string, string> = {}) {
  const source = readFileSync(join(process.cwd(), script), 'utf8');
  const block = source.match(/<<'NODE'\n([\s\S]*?)\nNODE\n/);
  if (!block) throw new Error(`${script}: brak bloku NODE`);

  const dir = mkdtempSync(join(tmpdir(), 'stripe-blik-skrypt-'));
  try {
    const main = join(dir, 'main.mjs');
    const preload = join(dir, 'preload.mjs');
    const calls = join(dir, 'calls.jsonl');
    writeFileSync(main, block[1]);
    writeFileSync(preload, PRELOAD);
    writeFileSync(calls, '');
    const result = spawnSync(process.execPath, ['--import', preload, main], {
      encoding: 'utf8',
      env: {
        NODE_ENV: 'test', // typ ProcessEnv z Next.js wymaga tego pola
        PATH: process.env.PATH,
        STRIPE_SECRET_KEY: WARTOSC_KLUCZA,
        TEST_ROUTES: JSON.stringify(routes),
        TEST_CALLS: calls,
        ...env,
      },
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      calls: readFileSync(calls, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Call),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Zamiast SSH: pomija opcje i adres, a resztę uruchamia tutaj, jak zdalna powłoka. */
const FAKE_SSH = `#!/usr/bin/env bash
while [ "$#" -gt 0 ]; do
  case "$1" in
    -i|-o) shift 2 ;;
    root@*) shift; break ;;
    *) shift ;;
  esac
done
exec "$@"
`;

/** Zamiast Dockera: jedna nazwa kontenera, a `exec` uruchamia polecenie ze zmiennymi `-e`. */
const FAKE_DOCKER = `#!/usr/bin/env bash
case "$1" in
  ps) echo "aplikacja-abc123" ;;
  exec)
    shift
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -i) shift ;;
        -e) export "$2"; shift 2 ;;
        *) break ;;
      esac
    done
    shift
    exec "$@"
    ;;
esac
`;

function runWholeScript(
  script: string,
  args: string[],
  routes: Route[],
  env: Record<string, string> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'stripe-blik-skrypt-'));
  try {
    const preload = join(dir, 'preload.mjs');
    const calls = join(dir, 'calls.jsonl');
    const infra = join(dir, 'infra.env');
    writeFileSync(preload, PRELOAD);
    writeFileSync(calls, '');
    writeFileSync(infra, 'K=/dev/null\nAPP=serwer.example.test\nAPP_PREFIX=aplikacja\n');
    for (const [name, content] of [['ssh', FAKE_SSH], ['docker', FAKE_DOCKER]] as const) {
      writeFileSync(join(dir, name), content);
      chmodSync(join(dir, name), 0o755);
    }
    const result = spawnSync('bash', [join(process.cwd(), script), ...args], {
      encoding: 'utf8',
      env: {
        NODE_ENV: 'test',
        PATH: [dir, dirname(process.execPath), process.env.PATH].join(':'),
        FAKTFLOW_INFRA_ENV: infra,
        NODE_OPTIONS: `--import=${preload}`,
        STRIPE_SECRET_KEY: WARTOSC_KLUCZA,
        TEST_ROUTES: JSON.stringify(routes),
        TEST_CALLS: calls,
        ...env,
      },
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      calls: readFileSync(calls, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Call),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function shellSyntaxError(script: string): string {
  return spawnSync('bash', ['-n', join(process.cwd(), script)], { encoding: 'utf8' }).stderr;
}

describe('stripe-blik-sprawdz.sh: przełącznik, capabilities i wersja zdarzeń webhooka', () => {
  const account = {
    match: '/v1/account',
    body: { capabilities: { blik_payments: 'active', blik_recurring_payments: 'active' } },
  };
  const endpoint = (api_version: string | null, url = 'https://faktway.example.test/api/stripe/webhook') => ({
    match: '/v1/webhook_endpoints',
    body: { data: [{ id: 'we_1', url, status: 'enabled', api_version }], has_more: false },
  });
  const lastEvent = (api_version: string | null) => ({
    match: '/v1/events',
    body: { data: api_version ? [{ id: 'evt_1', api_version }] : [], has_more: false },
  });
  const on = { STRIPE_BLIK_RECURRING: 'on' };

  it('endpoint z wersją przed basil: wszystko w porządku, kod 0', () => {
    const run = runContainerPart(CHECK, [account, endpoint('2024-11-20.acacia'), lastEvent('2026-09-30.endive')], on);

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('2024-11-20.acacia');
    expect(run.stdout).not.toContain('UWAGA');
  });

  it('endpoint z wersją bez `invoice.payment_intent` (basil i nowsze): ostrzeżenie i kod 1', () => {
    const run = runContainerPart(CHECK, [account, endpoint('2025-03-31.basil'), lastEvent('2024-11-20.acacia')], on);

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('UWAGA');
    expect(run.stdout).toContain('2025-03-31.basil');
    expect(run.stdout).toContain('docs/security/STRIPE-PARA-PI-CHARGE-ODBIOR-2026-09-25.md');
  });

  it('endpoint bez własnej wersji: liczy się domyślna wersja konta z ostatniego zdarzenia', () => {
    const good = runContainerPart(CHECK, [account, endpoint(null), lastEvent('2024-11-20.acacia')], on);
    expect(good.status).toBe(0);
    expect(good.stdout).toContain('domyślna wersja konta');
    expect(good.stdout).toContain('2024-11-20.acacia');

    const bad = runContainerPart(CHECK, [account, endpoint(null), lastEvent('2026-09-30.endive')], on);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('UWAGA');
  });

  it('endpoint bez własnej wersji i konto bez zdarzeń: wersja nieznana, kod 1', () => {
    const run = runContainerPart(CHECK, [account, endpoint(null), lastEvent(null)], on);

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('nieznana');
  });

  it('brak włączonego endpointu aplikacji: ostrzeżenie i kod 1', () => {
    const run = runContainerPart(
      CHECK,
      [account, endpoint('2024-11-20.acacia', 'https://inna.example.test/hook'), lastEvent('2024-11-20.acacia')],
      on,
    );

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('/api/stripe/webhook');
  });

  it('przełącznik włączony, a BLIK nieaktywny: kod 1 jak dotąd', () => {
    const run = runContainerPart(CHECK, [
      { match: '/v1/account', body: { capabilities: { blik_payments: 'active', blik_recurring_payments: 'inactive' } } },
      endpoint('2024-11-20.acacia'),
      lastEvent('2024-11-20.acacia'),
    ], on);

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('blik_recurring_payments: inactive');
  });

  it('odmowa Stripe przy którymkolwiek odczycie: kod 1, bez klucza na wyjściu', () => {
    const run = runContainerPart(CHECK, [
      account,
      { match: '/v1/webhook_endpoints', status: 403, body: { error: { message: 'Brak uprawnienia' } } },
      lastEvent('2024-11-20.acacia'),
    ], on);

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('Brak uprawnienia');
    expect(`${run.stdout}${run.stderr}`).not.toContain(WARTOSC_KLUCZA);
  });

  it('tylko odczyt, składnia powłoki poprawna', () => {
    const run = runContainerPart(CHECK, [account, endpoint('2024-11-20.acacia'), lastEvent('2024-11-20.acacia')], on);

    expect(run.calls.map((call) => call.method)).toEqual(['GET', 'GET', 'GET']);
    expect(shellSyntaxError(CHECK)).toBe('');
  });

  it('cały skrypt przez powłokę: bez argumentów dochodzi do odczytów i oddaje kod wyjścia', () => {
    const good = runWholeScript(CHECK, [], [account, endpoint('2024-11-20.acacia'), lastEvent('2024-11-20.acacia')], on);
    expect(good.stderr).toBe('');
    expect(good.status).toBe(0);
    expect(good.stdout).toContain('blik_recurring_payments: active');

    const bad = runWholeScript(CHECK, [], [account, endpoint('2025-03-31.basil'), lastEvent('2024-11-20.acacia')], on);
    expect(bad.status).toBe(1);
  });
});

describe('stripe-blik-wygas-sesje.sh: otwarte Session przy wycofaniu', () => {
  const blik = (id: string) => ({
    id,
    object: 'checkout.session',
    status: 'open',
    expires_at: 2_000_000_000,
    payment_method_types: ['card', 'blik'],
    url: 'https://checkout.stripe.test/' + id,
    customer_email: 'klient@example.test',
  });
  const cardOnly = (id: string) => ({ ...blik(id), payment_method_types: ['card'] });
  // Trasa z `starting_after` pierwsza: pierwsza strona też pasuje do `status=open`.
  const listing: Route[] = [
    { match: 'starting_after=cs_test_Karta', body: { data: [blik('cs_test_Blik2')], has_more: false } },
    { match: 'status=open', body: { data: [blik('cs_test_Blik1'), cardOnly('cs_test_Karta')], has_more: true } },
  ];
  const expired = (id: string): Route => ({
    method: 'POST',
    match: `/v1/checkout/sessions/${id}/expire`,
    body: { id, status: 'expired' },
  });
  const posts = (calls: Call[]) => calls.filter((call) => call.method === 'POST');

  it('bez argumentu: tylko pokazuje Session z BLIK-iem, ze wszystkich stron listy', () => {
    const run = runContainerPart(EXPIRE, listing, { BLIK_TRYB: 'podglad' });

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Otwarte Session: 3, z BLIK-iem: 2');
    expect(run.stdout).toContain('cs_test_Blik1');
    expect(run.stdout).toContain('cs_test_Blik2');
    expect(run.stdout).not.toContain('cs_test_Karta');
    expect(posts(run.calls)).toEqual([]);
  });

  it('--wygas przy wyłączonym przełączniku: wygasza tylko Session z BLIK-iem', () => {
    const run = runContainerPart(
      EXPIRE,
      [...listing, expired('cs_test_Blik1'), expired('cs_test_Blik2')],
      { BLIK_TRYB: 'wygas', STRIPE_BLIK_RECURRING: '' },
    );

    expect(run.status).toBe(0);
    expect(posts(run.calls).map((call) => call.url)).toEqual([
      'https://api.stripe.com/v1/checkout/sessions/cs_test_Blik1/expire',
      'https://api.stripe.com/v1/checkout/sessions/cs_test_Blik2/expire',
    ]);
    expect(run.stdout).toContain('Wygaszone: 2, błędy: 0');
  });

  it('--wygas przy włączonym przełączniku: nic nie wygasza, bo klient dostałby nową Session z BLIK-iem', () => {
    const run = runContainerPart(EXPIRE, listing, { BLIK_TRYB: 'wygas', STRIPE_BLIK_RECURRING: 'on' });

    expect(run.status).toBe(1);
    expect(run.calls).toEqual([]);
    expect(run.stdout).toContain('STRIPE_BLIK_RECURRING');
    expect(run.stdout).toContain('docs/runbooks/stripe-blik.md');
  });

  it('błąd jednej Session nie zatrzymuje pozostałych, kod 1', () => {
    const run = runContainerPart(EXPIRE, [
      ...listing,
      { method: 'POST', match: 'cs_test_Blik1/expire', status: 400, body: { error: { message: 'Session już zakończona' } } },
      expired('cs_test_Blik2'),
    ], { BLIK_TRYB: 'wygas' });

    expect(run.status).toBe(1);
    expect(posts(run.calls)).toHaveLength(2);
    expect(run.stdout).toContain('Session już zakończona');
    expect(run.stdout).toContain('Wygaszone: 1, błędy: 1');
  });

  it('odmowa przy liście: kod 1, bez wygaszania', () => {
    const run = runContainerPart(
      EXPIRE,
      [{ match: 'status=open', status: 401, body: { error: { message: 'Zły klucz' } } }],
      { BLIK_TRYB: 'wygas' },
    );

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('Zły klucz');
    expect(posts(run.calls)).toEqual([]);
  });

  it('na wyjściu nie ma klucza, adresu Session ani e-maila klienta', () => {
    const run = runContainerPart(
      EXPIRE,
      [...listing, expired('cs_test_Blik1'), expired('cs_test_Blik2')],
      { BLIK_TRYB: 'wygas' },
    );

    const output = `${run.stdout}${run.stderr}`;
    expect(output).not.toContain(WARTOSC_KLUCZA);
    expect(output).not.toContain('checkout.stripe.test');
    expect(output).not.toContain('klient@example.test');
  });

  it('cały skrypt przez powłokę: argument decyduje o trybie, bez niego nic się nie zmienia', () => {
    const preview = runWholeScript(EXPIRE, [], listing);
    expect(preview.stderr).toBe('');
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain('To podgląd');
    expect(posts(preview.calls)).toEqual([]);

    const expiring = runWholeScript(EXPIRE, ['--wygas'], [...listing, expired('cs_test_Blik1'), expired('cs_test_Blik2')]);
    expect(expiring.stderr).toBe('');
    expect(expiring.status).toBe(0);
    expect(posts(expiring.calls)).toHaveLength(2);
  });

  it('nieznany argument: kod 2, bez żadnego żądania', () => {
    const run = runWholeScript(EXPIRE, ['--wygasz'], listing);

    expect(run.status).toBe(2);
    expect(run.stderr).toContain('--wygas');
    expect(run.calls).toEqual([]);
  });

  it('jedna linia: sam ładuje infra.env, jest wykonywalny, składnia powłoki poprawna', () => {
    const source = readFileSync(join(process.cwd(), EXPIRE), 'utf8');

    expect(source).toContain('source "$ENV_FILE"');
    expect(statSync(join(process.cwd(), EXPIRE)).mode & 0o100).toBeTruthy();
    expect(shellSyntaxError(EXPIRE)).toBe('');
  });
});
