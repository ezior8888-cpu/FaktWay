import Link from 'next/link';
import { RiFileSearchLine } from '@remixicon/react';

import { buttonVariants } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';

/**
 * Brak faktury pod adresem `/invoices/[id]` (`notFound()` w `page.tsx`: nie ma
 * takiego wiersza albo RLS go nie pokazuje — faktura innej firmy). Układ
 * „Invoice Not Found” z Finory (`invoices-view/index.tsx`) w panelu, zamiast
 * ogólnej strony 404 bez nawigacji.
 */
export default function InvoiceNotFound() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <RiFileSearchLine />
        </EmptyMedia>
        <EmptyTitle>Nie znaleziono faktury</EmptyTitle>
        <EmptyDescription>
          Nie ma faktury pod tym adresem albo należy do innej firmy. Jeśli masz kilka firm, sprawdź, która jest
          wybrana.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Link href="/invoices" className={buttonVariants()}>
          Wróć do listy faktur
        </Link>
      </EmptyContent>
    </Empty>
  );
}
