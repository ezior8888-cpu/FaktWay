'use client';

import { useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { decideReceiptMatchAction } from '@/app/actions/receipt-invoice-match';
import { plDate } from '@/components/expenses/finora/labels';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { ReceiptMatchDoc, ReceiptMatchView } from '@/lib/expenses/receipt-invoice-match-view';
import { formatPlMoney } from '@/lib/format/pl';

/**
 * Krok 1.3 (00175): faktura do paragonu i paragon z NIP na stronie kosztu.
 * Ostrzeżenie o możliwym podwójnym koszcie widać na obu dokumentach; decyzja
 * zapada na stronie faktury (wejście ze Skrzynki KSeF). D1: istniejące
 * komponenty (`Alert`, `Button`) w miejscu na ostrzeżenia nad kartami.
 */

const docLine = (doc: ReceiptMatchDoc, kind: string) =>
  `${kind}${doc.number ? ` ${doc.number}` : ''} z ${plDate(doc.issueDate)}, ${formatPlMoney(doc.gross)} zł`;

export const RECEIPT_MATCH_TEXTS = {
  invoiceCandidatesTitle: 'Możliwy podwójny koszt',
  invoiceCandidatesBody:
    'Ta faktura może dotyczyć paragonu z NIP, który jest już w kosztach: ten sam sprzedawca i ta sama kwota. ' +
    'Jeśli to ten sam zakup, wystarczy wskazać paragon: koszt i VAT będą liczone tylko z faktury, a paragon wypadnie z KPiR i z odliczenia. ' +
    'Do tego czasu oba dokumenty liczą się w kosztach.',
  invoiceLinkedTitle: 'Faktura do paragonu połączona z paragonem',
  invoiceLinkedBody:
    'Koszt i VAT liczą się z tej faktury, a paragon nie wchodzi do KPiR ani do odliczenia VAT. ' +
    'Jeśli to inne zakupy, dokumenty można rozłączyć, a paragon wróci do kosztów.',
  receiptCandidatesTitle: 'Możliwy podwójny koszt',
  receiptCandidatesBody:
    'Z KSeF przyszła faktura od tego sprzedawcy na tę samą kwotę i może dotyczyć tego paragonu. ' +
    'Czy to ten sam zakup, wybiera się na stronie faktury. Do tego czasu oba dokumenty liczą się w kosztach.',
  receiptLinkedTitle: 'Paragon zastąpiony fakturą do paragonu',
  receiptLinkedBody:
    'Koszt i VAT liczą się z faktury do paragonu z KSeF, więc paragon nie wchodzi do KPiR ani do odliczenia VAT. ' +
    'Jeśli to inne zakupy, dokumenty rozłącza się na stronie faktury.',
} as const;

export function ReceiptMatchAlert({ match }: { match: ReceiptMatchView }) {
  const router = useRouter();
  const [pending, startDecision] = useTransition();

  const decide = (receiptExpenseId: string | null) => {
    const invoiceExpenseId = match.invoiceExpenseId;
    if (!invoiceExpenseId) return;
    startDecision(async () => {
      const result = await decideReceiptMatchAction(invoiceExpenseId, receiptExpenseId);
      if (result.success) {
        toast.success(result.result === 'linked' ? 'Połączono fakturę z paragonem' : 'Zapisano: to osobne koszty');
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  const t = RECEIPT_MATCH_TEXTS;
  const isInvoice = match.role === 'invoice';
  const title = isInvoice
    ? match.state === 'linked' ? t.invoiceLinkedTitle : t.invoiceCandidatesTitle
    : match.state === 'linked' ? t.receiptLinkedTitle : t.receiptCandidatesTitle;
  const body = isInvoice
    ? match.state === 'linked' ? t.invoiceLinkedBody : t.invoiceCandidatesBody
    : match.state === 'linked' ? t.receiptLinkedBody : t.receiptCandidatesBody;
  const kind = isInvoice ? 'Paragon' : 'Faktura do paragonu';

  return (
    <Alert role="alert" className="border-amber-600/30">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{body}</p>
        <ul className="space-y-2">
          {match.docs.map((doc) => (
            <li key={doc.expenseId} className="flex flex-wrap items-center gap-2">
              <Link href={`/expenses/${doc.expenseId}`} className="text-foreground underline underline-offset-2">
                {docLine(doc, kind)}
              </Link>
              {isInvoice && match.state === 'candidates' ? (
                <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => decide(doc.expenseId)}>
                  To ten paragon
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {isInvoice ? (
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => decide(null)}>
            {match.state === 'linked' ? 'Rozłącz dokumenty' : 'To osobne koszty'}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
