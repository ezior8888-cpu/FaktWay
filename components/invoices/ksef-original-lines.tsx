import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { DUPLICATE_DECISION_TEXTS } from '@/lib/ksef/duplicate-decision';
import type { OriginalPreview } from '@/lib/ksef/duplicate-check';

/** Stawka z pliku jak na podglądzie faktury: kody FA(3) bez procentu (`zw`, `oo`, `np`), liczby z „%”. */
function vatRateLabel(rate: string): string {
  if (rate === 'np_ii') return 'np. II';
  if (['zw', 'oo', 'np'].includes(rate)) return rate;
  return `${rate}%`;
}

/**
 * Pozycje faktury z KSeF w panelu decyzji (D-A4-1b-3 PR C, 6.1): rozwijana lista
 * `LINES_TOGGLE(n)` z pierwszymi pozycjami z `importGate.preview` (najwyżej 20,
 * nazwa do 120 znaków) i — gdy plik ma ich więcej — `LINES_MORE(m)` z odesłaniem
 * do pliku w KSeF. Podgląd jest zapisany na znaczniku przy werdykcie: strona nie
 * czyta archiwum (INV-13). Element `<details>` zamiast stanu — komponent nie
 * potrzebuje JavaScriptu.
 */
export function KsefOriginalLines({ preview }: { preview: OriginalPreview }) {
  const F = DUPLICATE_DECISION_TEXTS.FAKTFLOW;
  const more = preview.lineCount - preview.lines.length;

  return (
    <details className="rounded-md border border-amber-200 bg-white/60 px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium">{F.LINES_TOGGLE(preview.lineCount)}</summary>
      <Table className="mt-2">
        <TableHeader>
          <TableRow>
            <TableHead>{F.LINES_COLUMNS.name}</TableHead>
            <TableHead>{F.LINES_COLUMNS.quantity}</TableHead>
            <TableHead>{F.LINES_COLUMNS.unitPriceNet}</TableHead>
            <TableHead>{F.LINES_COLUMNS.vatRate}</TableHead>
            <TableHead>{F.LINES_COLUMNS.gross}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {preview.lines.map((line) => (
            <TableRow key={line.ordinal}>
              {/* Spacja po nazwie: tekst tabeli (kopiowanie, odczyt) nie skleja nazwy z ilością z następnej komórki. */}
              <TableCell className="align-top whitespace-normal break-words">{line.name}{' '}</TableCell>
              <TableCell className="align-top whitespace-normal">
                {line.quantity} {line.unit}
              </TableCell>
              <TableCell className="align-top whitespace-normal">{line.unitPriceNet ?? '—'}</TableCell>
              <TableCell className="align-top whitespace-normal">{vatRateLabel(line.vatRate)}</TableCell>
              <TableCell className="align-top whitespace-normal">{line.gross}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {more > 0 && <p className="mt-2 text-xs text-amber-900">{F.LINES_MORE(more)}</p>}
    </details>
  );
}
