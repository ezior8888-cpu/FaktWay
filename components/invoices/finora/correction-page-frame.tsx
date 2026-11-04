import type { ReactNode } from 'react';
import Link from 'next/link';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { InvoiceCreateGrid } from '@/components/invoices/finora/invoice-document';

/**
 * Ramka strony korekty (`/invoices/new/correction`) w układzie Finory (P5).
 *
 * TYLKO RAMKA. Wnętrze `correction-form.tsx` zmienia równolegle inny PR
 * (#283), więc formularz zostaje bez zmian — z własnym nagłówkiem i paskiem
 * akcji (`.ff-sticky-actions`), także na komputerze. Ramka daje mu tę samą
 * siatkę co pozostałym rodzajom faktur (dokument + kolumna 18rem), a w prawej
 * kolumnie tylko nawigację: zapis i wysyłkę niesie pasek formularza, więc
 * drugiego kompletu przycisków tu nie ma.
 */
export function CorrectionPageFrame({ children }: { children: ReactNode }) {
  return (
    <InvoiceCreateGrid>
      <div className="min-w-0">{children}</div>
      <Card data-testid="ramka-korekty" className="h-max shadow-none max-lg:hidden">
        <CardHeader>
          <CardTitle className="text-base">Faktura korygująca</CardTitle>
          <CardDescription className="text-sm">
            Korekta wystawionej faktury (dane, kwoty, anulowanie)
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Link href="/invoices/new" className="text-primary block underline-offset-4 hover:underline">
            Zmień rodzaj faktury
          </Link>
          <Link href="/invoices" className="text-primary block underline-offset-4 hover:underline">
            Wróć do listy faktur
          </Link>
        </CardContent>
      </Card>
    </InvoiceCreateGrid>
  );
}
