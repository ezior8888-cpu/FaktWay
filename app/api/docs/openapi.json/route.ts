import spec from '@/lib/api/v1/openapi.json';

/** `/api/docs/openapi.json`: opis OpenAPI 3.1 publicznego API, ten sam plik co w repo. */
export const dynamic = 'force-static';

export function GET() {
  return Response.json(spec, {
    headers: { 'Cache-Control': 'public, max-age=3600' },
  });
}
