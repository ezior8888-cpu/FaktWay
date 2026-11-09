import spec from '@/lib/api/v1/openapi.json';
import { API_KEY_SCOPE_LABELS, API_KEY_SCOPES } from '@/lib/api/v1/scopes';
import { PUBLIC_SITE_URL, SUPPORT_EMAIL } from '@/lib/site';

/**
 * Statyczna strona `/api/docs` z opisu OpenAPI (`openapi.json`): punkty,
 * parametry i pola biorą się z pliku, więc strona nie rozjedzie się z opisem.
 * Bez skryptów, bez danych firmy i bez zmiennych środowiska.
 */

type Schema = {
  type?: string | string[];
  format?: string;
  description?: string;
  enum?: (string | null)[];
  $ref?: string;
  oneOf?: Schema[];
  allOf?: Schema[];
  items?: Schema;
  properties?: Record<string, Schema>;
};
type Parameter = { name: string; in: string; description?: string; required?: boolean; schema?: Schema };
type Operation = { summary: string; description: string; parameters?: Parameter[] };

const schemas = spec.components.schemas as unknown as Record<string, Schema>;
const paths = spec.paths as unknown as Record<string, { get: Operation }>;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function refName(ref: string): string {
  return ref.split('/').at(-1) ?? ref;
}

/** Krótki opis typu pola: tekst, data, liczba, lista wartości. */
function typeLabel(schema: Schema | undefined): string {
  if (!schema) return '';
  if (schema.$ref) {
    const name = refName(schema.$ref);
    if (name === 'Decimal') return 'kwota (tekst)';
    if (name === 'Party') return 'obiekt: name, nip';
    return typeLabel(schemas[name]);
  }
  if (schema.oneOf) {
    const parts = schema.oneOf.map(typeLabel).filter((part) => part !== 'null');
    return `${parts.join(' albo ')} albo null`;
  }
  if (schema.enum) return schema.enum.filter((value) => value !== null).join(', ');
  const types = (Array.isArray(schema.type) ? schema.type : [schema.type ?? '']).filter(Boolean);
  const base = types
    .map((type) => {
      if (type === 'string' && schema.format === 'date') return 'data';
      if (type === 'string' && schema.format === 'date-time') return 'czas ISO 8601';
      if (type === 'string' && schema.format === 'uuid') return 'UUID';
      if (type === 'string') return 'tekst';
      if (type === 'integer') return 'liczba całkowita';
      if (type === 'boolean') return 'tak albo nie';
      if (type === 'array') return `lista: ${typeLabel(schema.items)}`;
      if (type === 'object') return 'obiekt';
      return type;
    })
    .filter((type) => type !== 'null');
  return types.includes('null') ? `${base.join(', ')} albo null` : base.join(', ');
}

function fieldDescription(schema: Schema | undefined): string {
  if (!schema) return '';
  if (schema.description) return schema.description;
  if (schema.$ref) return schemas[refName(schema.$ref)]?.description ?? '';
  return schema.oneOf?.map(fieldDescription).find(Boolean) ?? '';
}

function fieldsTable(schemaName: string): string {
  const properties = schemas[schemaName]?.properties ?? {};
  const rows = Object.entries(properties)
    .map(([name, schema]) => `<tr><td><code>${escapeHtml(name)}</code></td><td>${escapeHtml(typeLabel(schema))}</td><td>${escapeHtml(fieldDescription(schema))}</td></tr>`)
    .join('');
  return `<div class="table"><table><thead><tr><th>Pole</th><th>Typ</th><th>Opis</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function parametersTable(parameters: Parameter[]): string {
  if (parameters.length === 0) return '';
  const rows = parameters
    .map((p) => `<tr><td><code>${escapeHtml(p.name)}</code></td><td>${p.in === 'path' ? 'w adresie' : 'w zapytaniu'}</td><td>${escapeHtml(typeLabel(p.schema))}</td><td>${escapeHtml(p.description ?? '')}</td></tr>`)
    .join('');
  return `<div class="table"><table><thead><tr><th>Parametr</th><th>Gdzie</th><th>Wartości</th><th>Opis</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

const RESPONSE_SCHEMA: Record<string, string> = {
  '/invoices': 'Invoice',
  '/invoices/{id}': 'InvoiceDetail',
  '/expenses': 'Expense',
};

function endpointSection(path: string, operation: Operation): string {
  const fullPath = `/api/v1${path}`;
  const example = path.includes('{id}')
    ? `${PUBLIC_SITE_URL}${fullPath.replace('{id}', '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f')}`
    : `${PUBLIC_SITE_URL}${fullPath}?limit=10`;
  const schemaName = RESPONSE_SCHEMA[path] ?? 'Invoice';
  const fields = schemaName === 'InvoiceDetail'
    ? `${fieldsTable('Invoice')}<p>Do tego <code>items</code>, lista pozycji:</p>${fieldsTable('InvoiceItem')}`
    : fieldsTable(schemaName);
  const shape = path.includes('{id}')
    ? '<p>Odpowiedź: <code>{ "data": { … } }</code>.</p>'
    : '<p>Odpowiedź: <code>{ "data": [ … ], "next_cursor": "…" }</code>; <code>next_cursor</code> ma wartość <code>null</code> na ostatniej stronie.</p>';
  return [
    `<section class="endpoint" id="${escapeHtml(path.replace(/[^a-z]/g, '-'))}">`,
    `<h3><span class="method">GET</span> <code>${escapeHtml(fullPath)}</code></h3>`,
    `<p><strong>${escapeHtml(operation.summary)}.</strong> ${escapeHtml(operation.description)}</p>`,
    parametersTable(operation.parameters ?? []),
    `<pre><code>curl -H "Authorization: Bearer fwk_TWOJ_KLUCZ" "${escapeHtml(example)}"</code></pre>`,
    shape,
    fields,
    '</section>',
  ].join('\n');
}

const ERROR_ROWS: [string, string, string][] = [
  ['400', 'invalid_parameter', 'Nieznany albo błędny parametr. Opis podaje jego nazwę.'],
  ['401', 'missing_api_key', 'Brak nagłówka Authorization: Bearer.'],
  ['401', 'invalid_api_key', 'Klucz nieprawidłowy albo odwołany.'],
  ['403', 'insufficient_scope', 'Klucz nie ma zakresu potrzebnego temu punktowi.'],
  ['404', 'not_found', 'Nie ma takiej faktury w firmie klucza.'],
  ['429', 'rate_limited', 'Za dużo zapytań. Nagłówek Retry-After podaje, po ilu sekundach spróbować.'],
  ['503', 'api_disabled', 'API nie jest jeszcze udostępnione.'],
  ['503', 'maintenance', 'Przerwa techniczna.'],
  ['503', 'service_unavailable', 'Chwilowa awaria. Spróbuj ponownie za kilka minut.'],
  ['500', 'internal_error', 'Nieoczekiwany błąd. Podaj nam identyfikator żądania.'],
];

const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#111827;--muted:#4b5563;--line:#e5e7eb;--code:#f3f4f6;--accent:#1d4ed8}
@media (prefers-color-scheme:dark){:root{--bg:#0b0f17;--fg:#e5e7eb;--muted:#9ca3af;--line:#1f2937;--code:#111827;--accent:#93c5fd}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:960px;margin:0 auto;padding:32px 16px 64px}h1{font-size:2rem;margin:0 0 8px}h2{margin-top:40px;font-size:1.4rem}
h3{font-size:1.1rem;margin:0 0 8px}p,li{color:var(--muted)}strong,code{color:var(--fg)}a{color:var(--accent)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;background:var(--code);padding:1px 4px;border-radius:4px;word-break:break-word}
pre{background:var(--code);padding:12px;border-radius:8px;overflow-x:auto}pre code{padding:0;background:none;word-break:normal}
.endpoint{border:1px solid var(--line);border-radius:12px;padding:16px;margin:16px 0}.method{font-size:.8rem;font-weight:600;color:var(--accent)}
.table{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:.9rem;margin:12px 0}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{color:var(--fg);font-weight:600}td{color:var(--muted)}
`;

export function renderApiDocsHtml(): string {
  const scopes = API_KEY_SCOPES
    .map((scope) => `<li><code>${scope}</code>: ${escapeHtml(API_KEY_SCOPE_LABELS[scope].toLowerCase())}</li>`)
    .join('');
  const errors = ERROR_ROWS
    .map(([status, code, text]) => `<tr><td>${status}</td><td><code>${code}</code></td><td>${escapeHtml(text)}</td></tr>`)
    .join('');
  const endpoints = Object.entries(paths)
    .map(([path, item]) => endpointSection(path, item.get))
    .join('\n');

  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FaktWay API</title>
<meta name="description" content="Dokumentacja publicznego API FaktWay: odczyt faktur i kosztów firmy kluczem API.">
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>FaktWay API</h1>
<p>Odczyt faktur (wystawionych i otrzymanych z KSeF) i kosztów jednej firmy z Twojego programu. Wersja ${escapeHtml(spec.info.version)}. Opis w formacie OpenAPI 3.1: <a href="/api/docs/openapi.json"><code>/api/docs/openapi.json</code></a>.</p>

<h2>Klucz API</h2>
<ul>
<li>Klucz tworzy właściciel albo administrator firmy w Ustawieniach FaktWay, w zakładce API. Klucz działa tylko dla tej jednej firmy.</li>
<li>Pełny klucz widać tylko raz, przy utworzeniu. FaktWay przechowuje tylko jego skrót, więc zgubionego klucza nie da się odczytać: odwołaj go i utwórz nowy.</li>
<li>Klucz zaczyna się od <code>fwk_</code>. Trzymaj go na serwerze, nigdy w przeglądarce ani w aplikacji w telefonie.</li>
<li>Odwołany klucz przestaje działać od razu. Każde użycie klucza widać w dzienniku zdarzeń firmy (bez treści odpowiedzi).</li>
</ul>

<h2>Uwierzytelnianie</h2>
<p>Każde zapytanie wysyła klucz w nagłówku:</p>
<pre><code>Authorization: Bearer fwk_TWOJ_KLUCZ</code></pre>
<p>Zakresy klucza:</p>
<ul>${scopes}</ul>

<h2>Kwoty, daty i strony</h2>
<ul>
<li>Kwoty to tekst dziesiętny z kropką i dwoma miejscami po przecinku, np. <code>"1230.50"</code>, w walucie z pola <code>currency</code>. Ilość i cena jednostkowa pozycji mają do czterech miejsc po przecinku.</li>
<li>Daty mają format RRRR-MM-DD, czasy ISO 8601 ze strefą.</li>
<li>Listy są posortowane od najnowszej daty wystawienia. Kolejną stronę pobierasz z parametrem <code>cursor</code> równym <code>next_cursor</code> z poprzedniej odpowiedzi, aż dostaniesz <code>null</code>.</li>
<li>Nieznany parametr to błąd 400, żeby literówka w nazwie filtra nie zwróciła po cichu wszystkich danych.</li>
<li>Pola z listą wartości (np. <code>ksef_status</code>) mogą w przyszłości dostać nowe wartości. Program powinien je przyjąć bez błędu.</li>
</ul>

<h2>Limity</h2>
<p>60 zapytań na minutę na klucz i 600 na minutę z jednego adresu IP. Po przekroczeniu odpowiedź 429 z nagłówkiem <code>Retry-After</code>. Nagłówek <code>X-RateLimit-Remaining</code> mówi, ile zapytań zostało w bieżącej minucie.</p>

<h2>Błędy</h2>
<p>Błąd to JSON: <code>{ "error": { "code": "…", "message": "…" } }</code>. Program rozpoznaje błąd po polu <code>code</code>; <code>message</code> to opis po polsku dla człowieka. Każda odpowiedź ma nagłówek <code>X-Request-Id</code>: podaj go przy zgłoszeniu problemu na <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
<div class="table"><table><thead><tr><th>Status</th><th>Kod</th><th>Znaczenie</th></tr></thead><tbody>${errors}</tbody></table></div>

<h2>Punkty</h2>
${endpoints}
</main>
</body>
</html>
`;
}
