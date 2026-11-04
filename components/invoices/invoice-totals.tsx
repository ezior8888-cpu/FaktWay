import {
  summarizeVatPerRate,
  type InvoiceTotals as Totals,
} from '@/lib/xml/invoice-calculator';
import { formatPlMoney } from '@/lib/format/pl';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import type { InvoiceLineItem } from '@/types/invoice';

const OPIS_STAWKI: Record<string, string> = {
  oo: 'odwrotne obciążenie',
  np: 'nie podlega',
  // AUD-70: usługa z art. 100 ust. 1 pkt 4 (FA(3) „np II”) — bez opisu wyszłoby „VAT np_ii%”.
  np_ii: 'nie podlega (np. II)',
  zw: 'zwolniona',
};

function etykietaStawki(rate: string): string {
  const opis = OPIS_STAWKI[rate];
  return opis ? `VAT ${opis}` : `VAT ${rate}%`;
}

/**
 * Podsumowanie faktury: netto, VAT w rozbiciu na stawki, do zapłaty.
 *
 * JEDNO ŹRÓDŁO LICZB DLA OBU UKŁADÓW. Wcześniej stopka tabeli (komputer)
 * pokazywała tylko RAZEM netto i brutto — VAT nie pojawiał się nigdzie —
 * a karta podsumowania na telefonie liczyła VAT jako `brutto − netto`,
 * mimo że kalkulator zwraca `vatTotal` policzony pozycja po pozycji.
 * Przy stawkach mieszanych i zaokrągleniach do groszy te dwie liczby nie
 * muszą być równe, więc na fakturze była kwota VAT, której nie wyliczył
 * żaden przepis, tylko odejmowanie w interfejsie.
 *
 * Rozbicie na stawki idzie przez `summarizeVatPerRate` z tego samego modułu,
 * który generuje XML FA(3) — to, co klient widzi przed wysyłką, jest liczone
 * tą samą funkcją co to, co pójdzie do KSeF.
 *
 * „DO ZAPŁATY”, nie „RAZEM”: tak stoi na makiecie i tak nazywa to człowiek,
 * który patrzy na fakturę. Pierwszy wiersz to „Razem netto” (słownik planu
 * Finora, §6: Subtotal → Razem netto).
 */
export function InvoiceTotals({
  totals,
  lines,
  className,
}: {
  totals: Totals;
  lines: InvoiceLineItem[];
  className?: string;
}) {
  const stawki = summarizeVatPerRate(lines).filter(
    (s) => s.netSum !== 0 || s.vatSum !== 0,
  );

  // P5: blok „Subtotal / Tax / Total” Finory (`invoice-form.tsx`, `max-w-56
  // space-y-1.5 text-sm`, Separator przed sumą) — liczby bez zmian.
  return (
    <div className={cn('flex justify-end', className)}>
      <section aria-label="Podsumowanie faktury" className="w-full space-y-1.5 text-sm sm:max-w-80">
        <dl className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Razem netto</dt>
            <dd className="font-medium tabular-nums">{formatPlMoney(totals.netTotal)} zł</dd>
          </div>

          {stawki.map((s) => (
            <div key={s.rate} className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">{etykietaStawki(s.rate)}</dt>
              <dd className="font-medium tabular-nums">{formatPlMoney(s.vatSum)} zł</dd>
            </div>
          ))}
        </dl>

        <Separator className="my-2" />

        <div className="flex items-baseline justify-between gap-3">
          <span className="font-medium">Do zapłaty</span>
          <span className="text-base font-semibold tabular-nums">{formatPlMoney(totals.grossTotal)} zł</span>
        </div>
      </section>
    </div>
  );
}
