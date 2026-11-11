import { handleMcpPost, methodNotAllowed } from '@/lib/api/mcp/server';

export const dynamic = 'force-dynamic';

/**
 * `POST /api/mcp`: łącze MCP (krok 7.2) tylko do odczytu faktur, należności
 * i kosztów firmy klucza API. Ten sam klucz, limity i audyt co `/api/v1`.
 * Logika: `lib/api/mcp/server.ts`, narzędzia: `lib/api/mcp/tools.ts`,
 * opis dla klienta: `/api/docs`, sekcja „Łącze dla asystentów (MCP)”.
 */
export async function POST(request: Request) {
  return handleMcpPost(request);
}

export function GET() {
  return methodNotAllowed();
}

export function DELETE() {
  return methodNotAllowed();
}
