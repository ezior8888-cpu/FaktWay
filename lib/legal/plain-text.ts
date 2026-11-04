import { CONTRACT_DOCUMENTS } from '@/lib/legal/documents';
import { renderPlainText } from '@/lib/legal/doc-model';
import { entityIdentification, isLegalEntityComplete } from '@/lib/legal/entity';
import { siteUrl } from '@/lib/site';

/** Nagłówek każdego pliku: kto jest usługodawcą i czy to wersja robocza. */
export function legalTextHeader(): string[] {
  const lines = [`Usługodawca: ${entityIdentification()}`];
  if (!isLegalEntityComplete()) {
    lines.push('WERSJA ROBOCZA — dane usługodawcy nie są jeszcze kompletne.');
  }
  return lines;
}

/**
 * Pliki do maila z potwierdzeniem zawarcia umowy (trwały nośnik, art. 21
 * ustawy o prawach konsumenta). UTF-8 z BOM — bez BOM Notatnik w starszym
 * Windows pokazuje polskie znaki jako krzaki.
 */
export function contractAttachments(): Array<{ filename: string; content: Buffer }> {
  const header = legalTextHeader();
  return CONTRACT_DOCUMENTS.map((doc) => ({
    filename: `FaktWay-${doc.slug}-${doc.version}.txt`,
    content: Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(renderPlainText(doc, siteUrl(), header), 'utf8'),
    ]),
  }));
}
