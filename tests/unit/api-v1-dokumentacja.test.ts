import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 7.1, część 1: dokumentacja publicznego API. Plik OpenAPI 3.1 w repo
 * (`lib/api/v1/openapi.json`) jest jedynym opisem: z niego powstaje statyczna
 * strona `/api/docs`, a ten test pilnuje, żeby opis i trasy się nie rozjechały.
 */

import spec from '@/lib/api/v1/openapi.json';
import { EXPENSE_LIST_PARAMS } from '@/lib/api/v1/expenses';
import { INVOICE_LIST_PARAMS } from '@/lib/api/v1/invoices';
import { API_KEY_SCOPES } from '@/lib/api/v1/keys';
import { API_ERROR_CODES } from '@/lib/api/v1/responses';
import { INVOICE_CREATE_FIELDS } from '@/lib/api/v1/invoice-create';

type Operation = {
  security?: unknown[];
  parameters?: { name: string; in: string; required?: boolean }[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: { $ref?: string } }> };
  responses: Record<string, unknown>;
};
type Paths = Record<string, { get?: Operation; post?: Operation }>;
type SchemaObject = { properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };

const paths = spec.paths as unknown as Paths;

afterEach(() => vi.unstubAllEnvs());

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name === 'route.ts' ? [full] : [];
  });
}

describe('opis OpenAPI 3.1', () => {
  it('wersja, serwer /api/v1 i klucz w nagłówku Authorization: Bearer', () => {
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toContain('FaktWay');
    expect(spec.servers).toEqual([{ url: '/api/v1' }]);
    expect(spec.components.securitySchemes).toEqual({
      apiKey: expect.objectContaining({ type: 'http', scheme: 'bearer' }),
    });
  });

  it('każda trasa /api/v1 ma opis i każdy opis ma trasę', () => {
    const root = join(process.cwd(), 'app/api/v1');
    const fromRoutes = routeFiles(root)
      .map((file) => '/' + relative(root, file).split(sep).slice(0, -1).join('/'))
      .map((path) => path.replace(/\[(\w+)\]/g, '{$1}'))
      .sort();
    expect(Object.keys(paths).sort()).toEqual(fromRoutes);
  });

  it('każdy punkt wymaga klucza i opisuje błędy 400, 401, 403, 429 i 503', () => {
    for (const [path, item] of Object.entries(paths)) {
      const get = item.get;
      expect(get, path).toBeDefined();
      expect(get!.security, path).toEqual([{ apiKey: [] }]);
      for (const status of ['200', '400', '401', '403', '429', '503']) {
        expect(Object.keys(get!.responses), `${path} ${status}`).toContain(status);
      }
    }
    expect(Object.keys(paths['/invoices/{id}']!.get!.responses)).toContain('404');
  });

  it('parametry list w opisie to dokładnie parametry, które przyjmują trasy', () => {
    const names = (path: string) => (paths[path]!.get!.parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name).sort();
    expect(names('/invoices')).toEqual([...INVOICE_LIST_PARAMS].sort());
    expect(names('/expenses')).toEqual([...EXPENSE_LIST_PARAMS].sort());
  });

  it('zakresy w opisie to zakresy kluczy', () => {
    const text = JSON.stringify(spec);
    for (const scope of API_KEY_SCOPES) expect(text).toContain(scope);
  });

  it('kody błędów w opisie to dokładnie kody, które zwracają trasy', () => {
    const schemas = spec.components.schemas as unknown as Record<string, { properties: { error: { properties: { code: { enum: string[] } } } } }>;
    expect([...schemas.Error!.properties.error.properties.code.enum].sort()).toEqual([...API_ERROR_CODES].sort());
  });

  it('POST /invoices (krok 7.1, część 2): klucz invoices:write, Idempotency-Key, treść JSON i błędy', () => {
    const post = paths['/invoices']!.post;
    expect(post).toBeDefined();
    expect(post!.security).toEqual([{ apiKey: [] }]);
    expect(post!.parameters).toContainEqual(expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }));
    expect(post!.requestBody?.required).toBe(true);
    expect(post!.requestBody?.content?.['application/json']?.schema?.$ref).toBe('#/components/schemas/InvoiceCreate');
    for (const status of ['201', '400', '401', '403', '409', '413', '415', '422', '429', '503']) {
      expect(Object.keys(post!.responses), status).toContain(status);
    }
    expect(JSON.stringify(post)).toContain('invoices:write');
  });

  it('pola treści POST w opisie to dokładnie pola, które przyjmuje trasa (bez nieznanych)', () => {
    const schemas = spec.components.schemas as unknown as Record<string, SchemaObject>;
    const create = schemas.InvoiceCreate!;
    expect(create.additionalProperties).toBe(false);
    expect(Object.keys(create.properties ?? {}).sort()).toEqual([...INVOICE_CREATE_FIELDS.invoice].sort());
    expect(Object.keys(schemas.InvoiceCreateItem!.properties ?? {}).sort()).toEqual([...INVOICE_CREATE_FIELDS.item].sort());
    expect(Object.keys(schemas.InvoiceCreateBuyer!.properties ?? {}).sort()).toEqual([...INVOICE_CREATE_FIELDS.buyer].sort());
  });
});

describe('strona /api/docs i plik /api/docs/openapi.json', () => {
  it('strona: HTML z każdym punktem, bez sekretów, bez długich myślników', async () => {
    vi.stubEnv('SUPABASE_JWT_SECRET', 'dddddddddddddddddddddddddddddddd');
    // Wartości testowe przy nazwach sekretów bez entropii: skan sekretów (gitleaks) ich nie weźmie za klucz.
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 's'.repeat(40));
    const { GET, dynamic } = await import('@/app/api/docs/route');
    expect(dynamic).toBe('force-static');

    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await response.text();

    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<html lang="pl">');
    for (const path of Object.keys(paths)) expect(html).toContain(`/api/v1${path}`);
    expect(html).toContain('Authorization: Bearer');
    // POST z przykładem: klucz i klucz idempotencji w zmiennych, nie w treści strony.
    expect(html).toContain('POST');
    expect(html).toContain('Idempotency-Key: $');
    for (const code of ['idempotency_conflict', 'validation_failed', 'unsupported_invoice_kind', 'number_taken']) expect(html).toContain(code);
    for (const scope of API_KEY_SCOPES) expect(html).toContain(scope);
    expect(html).not.toContain('s'.repeat(40));
    expect(html).not.toMatch(/[—–]/);
    expect(html).not.toMatch(/FaktFlow/);
    expect(html).not.toContain('<script');
  });

  it('plik: ten sam opis OpenAPI jako JSON', async () => {
    const { GET, dynamic } = await import('@/app/api/docs/openapi.json/route');
    expect(dynamic).toBe('force-static');
    const response = GET();
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual(spec);
  });
});
