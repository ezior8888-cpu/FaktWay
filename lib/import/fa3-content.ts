/**
 * C5b: treść z pliku KSeF, którą import zapisuje na wierszu faktury — data
 * sprzedaży (`invoices.sale_date`) oraz adnotacje, daty pozycji i oznaczenia
 * w `fa3_data` (na górnym poziomie, tam gdzie czytają je JPK, PDF i korekta).
 * Jedno źródło dla silnika importu i dla zapisu oryginału po decyzji klienta
 * (D-A4-1b-3 PR C). Moduł czysty.
 */

import type { InvoiceAnnotations } from '@/types/invoice';
import {
  annotationsJpkCannotExpress,
  exemptionMismatch,
  invoiceAnnotationsFromFa3,
  markersJpkCannotExpress,
  type Fa3Markers,
} from '@/lib/xml/fa3-annotations';
import type { ParsedInvoice } from './fa3-parser';

export interface ImportSaleDates {
  /** OkresFa z pliku. */
  period?: { from: string; to: string };
  /** P_6A pozycji (po numerze pozycji). */
  lines?: Array<{ ordinal: number; date: string }>;
  /** Pozycje mają różne daty albo daty nie dało się odczytać — JPK odmawia. */
  unclear?: true;
}

export interface ImportContent {
  saleDate: string | null;
  /** `undefined` = parser nie czytał Adnotacji (pliki JPK/CSV) — nic nie zapisujemy. */
  annotations?: InvoiceAnnotations;
  annotationProblems: string[];
  saleDates?: ImportSaleDates;
  markers?: Fa3Markers;
}

/**
 * Data sprzedaży:
 * - zaliczka i korekta → NULL (P_6 to tam data otrzymania zaliczki albo stan
 *   po korekcie; FaktWay nie zapisuje `sale_date` dla własnych ZAL/KOR);
 * - jedna data w pliku (P_6, P_6_Do z OkresFa albo ta sama P_6A wszystkich
 *   pozycji) → ta data, także gdy równa dacie wystawienia (wiersz wierny plikowi);
 * - kilka dat — {P_6 albo P_6_Do} ∪ {P_6A}, a pozycja bez P_6A przy braku daty
 *   nagłówka ma datę wystawienia; P_6A poza OkresFa też — „niejasna”: nagłówek
 *   albo NULL, i odmowa JPK (jedna data sprzedaży na dokument).
 */
export function fa3ImportContent(inv: ParsedInvoice): ImportContent {
  const annotations = inv.ksefAnnotations ? invoiceAnnotationsFromFa3(inv.ksefAnnotations) : undefined;
  const annotationProblems = [...(inv.annotationProblems ?? [])];

  const headerDate = inv.saleDate ?? inv.salePeriod?.to;
  const lineDates = inv.lines
    .filter((l): l is typeof l & { saleDate: string } => Boolean(l.saleDate))
    .map((l) => ({ ordinal: l.position, date: l.saleDate }));
  const dates = new Set<string>(headerDate ? [headerDate] : []);
  for (const l of lineDates) dates.add(l.date);
  if (!headerDate && lineDates.length > 0 && lineDates.length < inv.lines.length && inv.issueDate) dates.add(inv.issueDate);
  const outsidePeriod = inv.salePeriod
    ? lineDates.some((l) => l.date < inv.salePeriod!.from || l.date > inv.salePeriod!.to)
    : false;
  const unclear = Boolean(inv.saleDateProblems?.length) || dates.size > 1 || outsidePeriod;

  const saleDates: ImportSaleDates = {
    ...(inv.salePeriod ? { period: inv.salePeriod } : {}),
    ...(lineDates.length ? { lines: lineDates } : {}),
    ...(unclear ? { unclear: true as const } : {}),
  };

  const special = inv.invoiceType === 'advance' || inv.invoiceType === 'correction';
  const saleDate = special
    ? null
    : unclear
      ? headerDate ?? null
      : dates.size === 1 ? [...dates][0]! : null;

  return {
    saleDate,
    ...(annotations ? { annotations } : {}),
    annotationProblems,
    ...(Object.keys(saleDates).length ? { saleDates } : {}),
    ...(inv.ksefMarkers ? { markers: inv.ksefMarkers } : {}),
  };
}

/**
 * Powody, dla których JPK FaktWay nie wykaże tej sprzedaży (te same co
 * odmowa w `amountsOf`), do ostrzeżenia na początku raportu importu.
 */
export function contentHeldReasons(inv: ParsedInvoice, content: ImportContent): string[] {
  const reasons: string[] = [];
  const cannot = [...annotationsJpkCannotExpress(content.annotations), ...markersJpkCannotExpress(content.markers)];
  if (cannot.length) reasons.push(`oznaczenie, którego FaktWay nie wykazuje w JPK — ${cannot.join(', ')}`);
  if (content.annotationProblems.length) {
    reasons.push(`adnotacji z KSeF nie udało się odczytać (${content.annotationProblems.join('; ')})`);
  }
  if (content.annotations && exemptionMismatch(content.annotations, inv.lines.map((l) => l.vatRate))) {
    reasons.push('zwolnienie z VAT (P_19) niezgodne ze stawkami pozycji');
  }
  if (content.saleDates?.unclear) {
    const lineDates = [...new Set((content.saleDates.lines ?? []).map((l) => l.date))].sort();
    reasons.push(inv.saleDateProblems?.length
      ? `daty sprzedaży nie udało się odczytać (${inv.saleDateProblems.join('; ')})`
      : `pozycje mają różne daty sprzedaży (P_6A: ${lineDates.join(', ')}${content.saleDate ? `; P_6: ${content.saleDate}` : ''})`);
  }
  return reasons;
}
