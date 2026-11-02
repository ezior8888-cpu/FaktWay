import Link from 'next/link';
import { FileInput } from 'lucide-react';

import { formatWarsawDateTime } from '@/lib/format/warsaw-date';
import {
  DUPLICATE_DECISION_TEXTS,
  decisionLabel,
  type ImportedOriginalProvenance,
} from '@/lib/ksef/duplicate-decision';

/**
 * Notatka na karcie faktury K zapisanej z KSeF decyzją klienta albo operatora
 * (D-A4-1b-3 PR C, 6.5): skąd ta faktura się wzięła — KSeF nie przyjął dokumentu
 * z FaktWay, bo miał już fakturę o jego numerze; odnośnik do wycofanego
 * dokumentu, uwaga o przypomnieniach o płatności (Q8) i o wpłatach.
 *
 * Dostaje tylko `ImportedOriginalProvenance` (`importedOriginalProvenance(fa3_data)`
 * liczy strona na serwerze) — treść dokumentu (`fa3_data`) nie trafia do komponentu.
 * Etykieta decyzji: oferta `record` albo `review-record` → „zapis faktury z KSeF”,
 * inaczej wybór (`decisionLabel`, jedna funkcja dla karty K, banera i toastów).
 */
export function ImportedOriginalNote({ provenance }: { provenance: ImportedOriginalProvenance }) {
  const F = DUPLICATE_DECISION_TEXTS.FAKTFLOW;
  const data = provenance.decidedAt ? formatWarsawDateTime(provenance.decidedAt) : '';
  const via = provenance.via === 'operator' ? DUPLICATE_DECISION_TEXTS.BANNER_VIA_OPERATOR : '';
  const choice = F.IMPORTED_CARD_CHOICE[decisionLabel(provenance.offer, provenance.choice)];

  return (
    <div className="space-y-2 rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-950 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-100">
      <div className="flex items-start gap-2">
        <FileInput className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <p>{F.IMPORTED_CARD(data, via, provenance.retiredInternalNumber, choice)}</p>
      </div>
      <p>
        <Link
          href={`/invoices/${encodeURIComponent(provenance.retiredInvoiceId)}`}
          className="font-medium underline underline-offset-2 hover:no-underline"
        >
          {F.IMPORTED_CARD_RETIRED_LINK}
        </Link>
      </p>
      <p>{F.IMPORTED_CARD_REMINDERS}</p>
      <p>{F.IMPORTED_CARD_PAYMENTS}</p>
    </div>
  );
}
