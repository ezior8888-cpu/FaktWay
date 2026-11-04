import { CONTRACT_DOCUMENTS, POLITYKA_COOKIES, POLITYKA_PRYWATNOSCI } from '@/lib/legal/documents';
import { legalTextHeader } from '@/lib/legal/plain-text';
import { renderPlainText } from '@/lib/legal/doc-model';
import { siteUrl } from '@/lib/site';

/**
 * Wersja tekstowa dokumentu do zapisania (art. 8 ust. 1 pkt 2 u.ś.u.d.e.:
 * regulamin udostępnia się w sposób umożliwiający jego utrwalenie). Ten sam
 * tekst, który dostaje klient w mailu po akceptacji.
 */
const DOCS = new Map(
  [...CONTRACT_DOCUMENTS, POLITYKA_PRYWATNOSCI, POLITYKA_COOKIES].map((d) => [d.slug, d]),
);

export const dynamic = 'force-static';

export function generateStaticParams() {
  return [...DOCS.keys()].map((slug) => ({ slug }));
}

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const doc = DOCS.get(slug);
  if (!doc) return new Response('Nie ma takiego dokumentu.', { status: 404 });
  // BOM: Notatnik w starszym Windows bez niego psuje polskie znaki.
  const body = '﻿' + renderPlainText(doc, siteUrl(), legalTextHeader());
  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="FaktWay-${doc.slug}-${doc.version}.txt"`,
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
