import 'server-only';

import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import {
  MCP_TOOLS,
  McpInputError,
  toolInputJsonSchema,
  type McpTool,
} from '@/lib/api/mcp/tools';
import { authenticateApiRequest, type ApiAuthResult } from '@/lib/api/v1/auth';
import { ApiUpstreamError, apiError } from '@/lib/api/v1/responses';
import type { ApiKeyScope } from '@/lib/api/v1/scopes';
import { siteUrl, PUBLIC_SITE_URL } from '@/lib/site';

/**
 * Łącze MCP (Model Context Protocol), krok 7.2 planu kompletnej aplikacji.
 *
 * Transport Streamable HTTP w najprostszej, bezstanowej postaci: jeden punkt
 * `POST /api/mcp`, odpowiedzi `application/json` (bez SSE), bez sesji. Każde
 * żądanie uwierzytelnia ten sam klucz API i ta sama funkcja co `/api/v1`
 * (`authenticateApiRequest`: flaga `publicApiEnabled`, limity na adres i na
 * klucz, token roli `api_key_client`, wpis w audycie). Narzędzia są tylko do
 * odczytu (`lib/api/mcp/tools.ts`).
 *
 * Błędy: odmowy dostępu (brak klucza, zły klucz, limit, flaga) to dokładnie
 * te same odpowiedzi co w API, bo asystent musi je odróżnić po statusie HTTP.
 * Błędy protokołu to błędy JSON-RPC, a błąd danych wejściowych narzędzia to
 * wynik narzędzia z `isError`, żeby asystent mógł poprawić wywołanie.
 * Szczegóły wewnętrzne idą wyłącznie do Sentry.
 */

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export const MCP_MAX_BODY_BYTES = 32 * 1024;

const SERVER_VERSION = '1.0.0';
const READ_SCOPES: readonly ApiKeyScope[] = ['invoices:read', 'expenses:read'];

const INSTRUCTIONS =
  'FaktWay: odczyt faktur, należności i kosztów jednej firmy. Wszystkie narzędzia są tylko do odczytu: '
  + 'nie wystawiają faktur, niczego nie wysyłają i niczego nie zmieniają. Kwoty są liczbami, a waluta jest w polu currency.';

const JSON_RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

type RpcId = string | number;

interface RpcRequest {
  id?: RpcId;
  method: string;
  params: Record<string, unknown>;
}

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function rpcResult(id: RpcId, result: unknown, headers: Record<string, string>): NextResponse {
  return NextResponse.json({ jsonrpc: '2.0', id, result }, { status: 200, headers: { ...NO_STORE, ...headers } });
}

function rpcError(
  id: RpcId | null,
  code: number,
  message: string,
  headers: Record<string, string>,
  status = 200,
): NextResponse {
  return NextResponse.json({ jsonrpc: '2.0', id, error: { code, message } }, { status, headers: { ...NO_STORE, ...headers } });
}

/** `GET` i `DELETE`: łącze nie otwiera strumienia SSE ani sesji, więc tylko `POST`. */
export function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { error: { code: 'method_not_allowed', message: 'Łącze MCP FaktWay przyjmuje tylko POST.' } },
    { status: 405, headers: { ...NO_STORE, Allow: 'POST' } },
  );
}

/**
 * Nagłówek `Origin` (ochrona przed DNS rebinding, wymagana przez specyfikację):
 * brak nagłówka to klient serwerowy, dozwolony; przeglądarka musi pochodzić ze strony FaktWay.
 */
function originAllowed(origin: string | null): boolean {
  if (origin === null) return true;
  const allowed = new Set([siteUrl(), PUBLIC_SITE_URL, PUBLIC_SITE_URL.replace('https://', 'https://www.')]);
  return allowed.has(origin.replace(/\/+$/, ''));
}

/** Dzisiejsza data w Polsce (RRRR-MM-DD): „po terminie” liczymy od polskiego dnia, nie od UTC. */
function warsawToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEnvelope(value: unknown): RpcRequest | null {
  if (!isRecord(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string') return null;
  const { id, params } = value;
  if (id !== undefined && typeof id !== 'string' && !(typeof id === 'number' && Number.isFinite(id))) return null;
  if (params !== undefined && !isRecord(params)) return null;
  return { id, method: value.method, params: params ?? {} };
}

async function readBody(request: Request): Promise<{ ok: true; text: string } | { ok: false }> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MCP_MAX_BODY_BYTES) return { ok: false };
  const text = await request.text();
  return Buffer.byteLength(text, 'utf8') > MCP_MAX_BODY_BYTES ? { ok: false } : { ok: true, text };
}

function allowedTools(scopes: readonly ApiKeyScope[]): McpTool[] {
  return MCP_TOOLS.filter((tool) => scopes.includes(tool.scope));
}

function toolDescriptor(tool: McpTool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: toolInputJsonSchema(tool),
    annotations: { title: tool.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };
}

function toolText(data: Record<string, unknown>, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, ...(isError ? { isError: true } : {}) };
}

function toolFailure(message: string) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function callTool(
  auth: Extract<ApiAuthResult, { ok: true }>,
  request: RpcRequest & { id: RpcId },
): Promise<NextResponse> {
  const { name, arguments: args } = request.params;
  if (typeof name !== 'string') {
    return rpcError(request.id, JSON_RPC_ERRORS.invalidParams, 'Brak nazwy narzędzia (pole name).', auth.headers);
  }
  const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) {
    return rpcError(request.id, JSON_RPC_ERRORS.invalidParams, `Nieznane narzędzie „${name.slice(0, 60)}”. Lista: tools/list.`, auth.headers);
  }
  if (!auth.key.scopes.includes(tool.scope)) {
    return rpcResult(
      request.id,
      toolFailure(`Ten klucz API nie ma uprawnienia ${tool.scope}. Utwórz klucz z tym uprawnieniem w Ustawieniach FaktWay.`),
      auth.headers,
    );
  }
  try {
    const data = await tool.run({ db: auth.db, tenantId: auth.key.tenantId, today: warsawToday() }, args);
    return rpcResult(request.id, toolText(data), auth.headers);
  } catch (error) {
    if (error instanceof McpInputError) return rpcResult(request.id, toolFailure(error.message), auth.headers);
    if (error instanceof ApiUpstreamError) {
      Sentry.captureMessage(error.message, { level: 'error', tags: { area: 'api.mcp' }, extra: { requestId: auth.requestId } });
      return rpcError(request.id, JSON_RPC_ERRORS.internal, 'FaktWay jest chwilowo niedostępny. Spróbuj ponownie za kilka minut.', auth.headers);
    }
    Sentry.captureException(error, { tags: { area: 'api.mcp' }, extra: { requestId: auth.requestId } });
    return rpcError(
      request.id,
      JSON_RPC_ERRORS.internal,
      `Nieoczekiwany błąd. Podaj nam identyfikator żądania ${auth.requestId}.`,
      auth.headers,
    );
  }
}

export async function handleMcpPost(request: Request): Promise<Response> {
  if (!originAllowed(request.headers.get('origin'))) {
    return apiError(403, 'forbidden_origin', 'Nagłówek Origin tego żądania jest niedozwolony. Łącze MCP przyjmuje żądania z aplikacji asystenta, nie ze stron internetowych.');
  }

  const auth = await authenticateApiRequest(request, { scope: null });
  if (!auth.ok) return auth.response;

  // Łącze czyta tylko faktury i koszty: klucz bez żadnego zakresu odczytu (np. sam do wystawiania) nie ma tu czego robić.
  if (!READ_SCOPES.some((scope) => auth.key.scopes.includes(scope))) {
    return apiError(403, 'insufficient_scope', 'Ten klucz API nie ma uprawnień do odczytu. Utwórz klucz z uprawnieniem invoices:read lub expenses:read w Ustawieniach FaktWay.', {
      ...auth.headers,
      'WWW-Authenticate': 'Bearer realm="FaktWay API", error="insufficient_scope", scope="invoices:read expenses:read"',
    });
  }

  const raw = await readBody(request);
  if (!raw.ok) {
    return apiError(413, 'payload_too_large', `Treść żądania może mieć najwyżej ${MCP_MAX_BODY_BYTES} bajtów.`, auth.headers);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.text);
  } catch {
    return rpcError(null, JSON_RPC_ERRORS.parse, 'Treść żądania nie jest poprawnym JSON.', auth.headers, 400);
  }
  const rpc = parseEnvelope(parsed);
  if (!rpc) {
    return rpcError(null, JSON_RPC_ERRORS.invalidRequest, 'To nie jest poprawne żądanie JSON-RPC 2.0 (paczki żądań nie są obsługiwane).', auth.headers, 400);
  }

  // Powiadomienie (bez id): przyjmujemy bez treści odpowiedzi.
  if (rpc.id === undefined) return new NextResponse(null, { status: 202, headers: { ...NO_STORE, ...auth.headers } });
  const withId = { ...rpc, id: rpc.id };

  switch (rpc.method) {
    case 'initialize': {
      const requested = rpc.params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.find((version) => version === requested) ?? LATEST_PROTOCOL_VERSION;
      return rpcResult(rpc.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'faktway', title: 'FaktWay', version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      }, auth.headers);
    }
    case 'ping':
      return rpcResult(rpc.id, {}, auth.headers);
    case 'tools/list':
      return rpcResult(rpc.id, { tools: allowedTools(auth.key.scopes).map(toolDescriptor) }, auth.headers);
    case 'tools/call':
      return callTool(auth, withId);
    default:
      return rpcError(rpc.id, JSON_RPC_ERRORS.methodNotFound, `Nieznana metoda „${rpc.method.slice(0, 60)}”.`, auth.headers);
  }
}
