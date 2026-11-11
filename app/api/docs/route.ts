import { renderApiDocsHtml } from '@/lib/api/v1/docs-page';

/**
 * `/api/docs`: statyczna dokumentacja publicznego API, zbudowana z opisu
 * OpenAPI w czasie budowania. Bez sesji (proxy przepuszcza ją jak `/api/v1`),
 * bez danych firmy i bez sekretów.
 */
export const dynamic = 'force-static';

export function GET() {
  return new Response(renderApiDocsHtml(), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
