import Link from 'next/link';
import { RiArrowRightLine } from '@remixicon/react';

import { ExpenseCaptureCard } from '@/components/expenses/expense-capture-card';
import { InvoiceTypePreview, type InvoiceTypePreviewVariant } from '@/components/invoices/invoice-type-preview';
import { Card } from '@/components/ui/card';

/**
 * Wybór rodzaju faktury (`/invoices/new`), tu prowadzi przycisk „Nowa
 * faktura” pod logo i „Nowa” z dolnego paska telefonu.
 *
 * Układ z poprawki Bartosza 11.11.2026 („wszystko jest nierówno, dziwne
 * ikony”): cztery karty o tej samej budowie w jednym rzędzie od `xl` (2×2 od
 * `sm`). U góry każdej karty miniatura dokumentu (`InvoiceTypePreview`)
 * zamiast ikony, pod nią nazwa i jedno zdanie opisu. Na telefonie karta jest
 * niskim wierszem: pomniejszona miniatura z lewej, tekst z prawej.
 * Cała karta jest linkiem, adresy i nazwy bez zmian.
 *
 * „Wydatek” ze zdjęcia jest osobnym, niższym pasem pod kartami: to nie
 * faktura sprzedażowa. Poniżej `lg` (tam, gdzie jest dolny pasek telefonu)
 * stoi na górze, bo na telefonie ludzie głównie dodają koszty (poprawka
 * Bartosza 25.10.2026). W DOM jest za kartami, żeby na komputerze klawisz Tab
 * szedł w kolejności, którą widać.
 */
const INVOICE_TYPES: ReadonlyArray<{
  type: InvoiceTypePreviewVariant;
  label: string;
  description: string;
}> = [
  {
    type: 'regular',
    label: 'Faktura zwykła',
    description: 'Standardowa faktura sprzedażowa dla firmy albo osoby prywatnej.',
  },
  {
    type: 'correction',
    label: 'Faktura korygująca',
    description: 'Zmiana danych lub kwot na wystawionej fakturze albo jej anulowanie.',
  },
  {
    type: 'advance',
    label: 'Faktura zaliczkowa',
    description: 'Zaliczka na poczet dostawy albo usługi, którą wykonasz później.',
  },
  {
    type: 'final',
    label: 'Faktura rozliczająca',
    description: 'Końcowe rozliczenie, od którego odejmiemy wystawione zaliczki.',
  },
];

export function InvoiceTypeSelector() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-8 pb-10">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Nowa faktura</h1>
        <p className="text-muted-foreground text-sm">
          Wybierz rodzaj dokumentu. W większości przypadków to faktura zwykła.
        </p>
      </header>

      <div className="flex flex-col gap-8">
        <ul aria-label="Rodzaj faktury" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {INVOICE_TYPES.map((it) => (
            <li key={it.type} className="flex">
              <Link
                href={`/invoices/new/${it.type}`}
                className="group focus-visible:outline-ring flex w-full outline-none focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                <Card className="group-hover:ring-primary/45 w-full flex-row gap-0 py-0 shadow-none sm:flex-col transition-[box-shadow] group-hover:shadow-[0_8px_24px_-12px_color-mix(in_oklch,var(--primary)_45%,transparent)]">
                  <div className="bg-muted border-foreground/8 relative w-24 shrink-0 overflow-hidden border-r sm:h-40 sm:w-auto sm:border-r-0 sm:border-b bg-[radial-gradient(color-mix(in_oklch,var(--foreground)_9%,transparent)_1px,transparent_1px)] bg-size-[14px_14px]">
                    <InvoiceTypePreview
                      variant={it.type}
                      className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 scale-50 transition-transform duration-300 ease-out motion-reduce:transition-none sm:top-6 sm:translate-y-0 sm:scale-100 sm:group-hover:-translate-y-1.5"
                    />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-4 sm:p-5">
                    <div className="flex items-center justify-between gap-3">
                      <h2 className="text-base font-semibold tracking-tight">{it.label}</h2>
                      <RiArrowRightLine
                        aria-hidden
                        className="text-muted-foreground group-hover:text-primary size-4 shrink-0 transition-[color,translate] group-hover:translate-x-0.5"
                      />
                    </div>
                    <p className="text-muted-foreground text-sm leading-relaxed">{it.description}</p>
                  </div>
                </Card>
              </Link>
            </li>
          ))}
        </ul>

        <section aria-label="Wydatek" className="max-lg:order-first">
          <ExpenseCaptureCard />
        </section>
      </div>
    </div>
  );
}
