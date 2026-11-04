import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  RiArrowRightLine,
  RiCheckboxCircleLine,
  RiFileEditLine,
  RiFileList3Line,
  RiHandCoinLine,
} from '@remixicon/react';

import { ExpenseCaptureCard } from '@/components/expenses/expense-capture-card';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card';

/**
 * Wybór rodzaju faktury (`/invoices/new`) w kartach Finory (P5).
 *
 * Karta jak `statistics-card-03.tsx` Finory: ikona w `Avatar` (`bg-primary/10
 * text-primary`), tytuł i opis w treści. Cała karta jest linkiem — cztery
 * adresy i teksty bez zmian względem wersji przed P5.
 *
 * Pierwszy kafel to „Wydatek” ze zdjęcia albo pliku (poprawka Bartosza
 * 25.10.2026): plus dolnego paska telefonu prowadzi tutaj, a na telefonie
 * najczęściej dodaje się koszty.
 */
const INVOICE_TYPES: ReadonlyArray<{
  type: 'regular' | 'correction' | 'advance' | 'final';
  label: string;
  description: string;
  icon: ReactNode;
}> = [
  {
    type: 'regular',
    label: 'Faktura zwykła',
    description: 'Standardowa faktura sprzedażowa B2B lub B2C',
    icon: <RiFileList3Line />,
  },
  {
    type: 'correction',
    label: 'Faktura korygująca',
    description: 'Korekta wystawionej faktury (dane, kwoty, anulowanie)',
    icon: <RiFileEditLine />,
  },
  {
    type: 'advance',
    label: 'Faktura zaliczkowa',
    description: 'Zaliczka na poczet przyszłej dostawy lub usługi',
    icon: <RiHandCoinLine />,
  },
  {
    type: 'final',
    label: 'Faktura rozliczająca',
    description: 'Rozliczenie wcześniej wystawionych zaliczek',
    icon: <RiCheckboxCircleLine />,
  },
];

export function InvoiceTypeSelector() {
  return (
    <div className="space-y-6 pb-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Nowa faktura</h1>
        <p className="text-muted-foreground text-sm">
          Wybierz rodzaj faktury albo dodaj wydatek ze zdjęcia.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <ExpenseCaptureCard />
        {INVOICE_TYPES.map((it) => (
          <Link
            key={it.type}
            href={`/invoices/new/${it.type}`}
            className="group focus-visible:ring-ring/50 block outline-none focus-visible:ring-2"
          >
            <Card className="group-hover:ring-primary/40 h-full shadow-none transition-shadow">
              <CardHeader>
                <Avatar className="size-9.5 after:border-0">
                  <AvatarFallback className="bg-primary/10 text-primary size-9.5 shrink-0 [&>svg]:size-4.75">
                    {it.icon}
                  </AvatarFallback>
                </Avatar>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-1">
                <h2 className="text-lg font-semibold">{it.label}</h2>
                <p className="text-muted-foreground text-sm">{it.description}</p>
              </CardContent>
              <CardFooter className="text-primary gap-2 text-sm font-medium">
                Wypełnij formularz
                <RiArrowRightLine className="size-4 transition-transform group-hover:translate-x-1" aria-hidden />
              </CardFooter>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
