import type { FieldArrayWithId, UseFormReturn } from 'react-hook-form';
import { Trash2 } from 'lucide-react';
import { RiAddLine, RiCloseLine } from '@remixicon/react';

import { DocumentSection } from '@/components/invoices/finora/invoice-document';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatPlMoney } from '@/lib/format/pl';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';
import { cn } from '@/lib/utils';
import { calculateLineItem } from '@/lib/xml/invoice-calculator';

import { FieldErrorText, fieldErrorProps } from './field-error-text';
import { labelClass, LINE_GRID, vatSelectClass } from './constants';

/**
 * Sekcja „Pozycje”: wiersze siatki od 1360 px albo karty
 * (`useLinesDesktopLayout`), dodawanie i usuwanie pozycji. Sumy liczy
 * formularz (`toLineItems`) i pokazuje pod sekcją.
 */
export function LineItemsSection({
  form,
  fields,
  watchedLines,
  linesDesktopLayout,
  remove,
  onAddLine,
}: {
  form: UseFormReturn<InvoiceFormValues>;
  fields: FieldArrayWithId<InvoiceFormValues, 'lines', 'id'>[];
  watchedLines: InvoiceFormValues['lines'] | undefined;
  linesDesktopLayout: boolean;
  remove: (index: number) => void;
  onAddLine: () => void;
}) {
  /** Błąd stawki pozycji — np. „np. II” bez nabywcy z UE (AUD-70). */
  const bladStawki = (index: number): string | undefined =>
    form.formState.errors.lines?.[index]?.vatRate?.message;

  // POZYCJE (Finora: `invoice-line-items.tsx`) — wiersze siatki vs karty
  // wg `linesDesktopLayout` (od 1360 px, `LINES_LAYOUT_MEDIA`).
  return (
    <DocumentSection title="Pozycje" testId="sekcja-pozycje" description="Towary i usługi na fakturze">
      {/* Tylko jeden wariant layoutu naraz — patrz `linesDesktopLayout` powyżej. */}
      {linesDesktopLayout ? (
        <div className="-mx-1 overflow-x-auto px-1">
          <div className="min-w-[38rem] space-y-3">
            <div className={cn(LINE_GRID, 'text-muted-foreground text-xs font-medium')}>
              <span>Nazwa</span>
              <span>J.m.</span>
              <span>Ilość</span>
              <span>Cena netto</span>
              <span>VAT</span>
              <span className="text-right">Brutto</span>
              <span />
            </div>
            {fields.map((field, index) => {
              const w = watchedLines?.[index];
              const calc = calculateLineItem({
                quantity: Number(w?.quantity) || 0,
                unitPriceNet: Number(w?.unitPriceNet) || 0,
                vatRate: w?.vatRate ?? '23',
              });
              return (
                <div key={field.id} className={cn(LINE_GRID, 'items-start')}>
                  <Input
                    aria-label={`Nazwa pozycji ${index + 1}`}
                    {...form.register(`lines.${index}.name`)}
                  />
                  <Input
                    aria-label={`Jednostka pozycji ${index + 1}`}
                    {...form.register(`lines.${index}.unit`)}
                  />
                  <Input
                    type="number"
                    step="0.0001"
                    inputMode="decimal"
                    aria-label={`Ilość pozycji ${index + 1}`}
                    className="text-right tabular-nums"
                    {...form.register(`lines.${index}.quantity`, {
                      valueAsNumber: true,
                    })}
                  />
                  <Input
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    aria-label={`Cena netto pozycji ${index + 1}`}
                    className="text-right tabular-nums"
                    {...form.register(`lines.${index}.unitPriceNet`, {
                      valueAsNumber: true,
                    })}
                  />
                  <select
                    className={vatSelectClass}
                    aria-label={`Stawka VAT pozycji ${index + 1}`}
                    {...fieldErrorProps('lines-vat-rate', !!bladStawki(index))}
                    title={bladStawki(index)}
                    {...form.register(`lines.${index}.vatRate`)}
                  >
                    <option value="23">23%</option>
                    <option value="8">8%</option>
                    <option value="5">5%</option>
                    <option value="0">0%</option>
                    <option value="zw">zw</option>
                    <option value="oo">oo</option>
                    <option value="np">np</option>
                    <option value="np_ii">np. II (usługa dla firmy z UE)</option>
                  </select>
                  <span className="mt-1.5 text-right text-sm tabular-nums">
                    <span className="block font-medium">{formatPlMoney(calc.grossAmount)} zł</span>
                    <span className="text-muted-foreground block text-xs">
                      netto {formatPlMoney(calc.netAmount)} zł
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Usuń pozycję ${index + 1}`}
                    disabled={fields.length === 1}
                    onClick={() => remove(index)}
                    className="hover:text-destructive"
                  >
                    <RiCloseLine className="size-4" />
                  </Button>
                </div>
              );
            })}
          </div>
          {/* Komórka stawki jest za wąska na komunikat — jeden pod wierszami. */}
          {fields.some((_, i) => bladStawki(i)) ? (
            <FieldErrorText fieldId="lines-vat-rate">
              {fields.map((_, i) => bladStawki(i)).find(Boolean)}
            </FieldErrorText>
          ) : null}
        </div>
      ) : (
        <div className="space-y-3">
          {fields.map((field, index) => {
            const w = watchedLines?.[index];
            const calc = calculateLineItem({
              quantity: Number(w?.quantity) || 0,
              unitPriceNet: Number(w?.unitPriceNet) || 0,
              vatRate: w?.vatRate ?? '23',
            });
            return (
              <div key={field.id} className="border-border space-y-3 border p-4">
                <div className="flex items-center justify-between">
                  <span className="bg-foreground text-background inline-flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium">
                    {index + 1}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Usuń pozycję ${index + 1}`}
                    disabled={fields.length === 1}
                    onClick={() => remove(index)}
                    className="hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>

                <div>
                  <Label htmlFor={`line-${index}-name`} className={labelClass}>Nazwa pozycji</Label>
                  <Input
                    id={`line-${index}-name`}
                    placeholder="np. Usługa programistyczna"
                    {...form.register(`lines.${index}.name`)}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor={`line-${index}-quantity`} className={labelClass}>Ilość</Label>
                    <Input
                      id={`line-${index}-quantity`}
                      type="number"
                      step="0.0001"
                      inputMode="decimal"
                      className="text-right tabular-nums"
                      {...form.register(`lines.${index}.quantity`, {
                        valueAsNumber: true,
                      })}
                    />
                  </div>
                  <div>
                    <Label htmlFor={`line-${index}-unit`} className={labelClass}>Jednostka</Label>
                    <Input
                      id={`line-${index}-unit`}
                      placeholder="szt."
                      {...form.register(`lines.${index}.unit`)}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor={`line-${index}-unit-price`} className={labelClass}>Cena netto (zł)</Label>
                    <Input
                      id={`line-${index}-unit-price`}
                      type="number"
                      step="0.01"
                      inputMode="decimal"
                      className="text-right tabular-nums"
                      {...form.register(`lines.${index}.unitPriceNet`, {
                        valueAsNumber: true,
                      })}
                    />
                  </div>
                  <div>
                    <Label htmlFor={`line-${index}-vat-rate`} className={labelClass}>
                      Stawka VAT
                    </Label>
                    <select
                      id={`line-${index}-vat-rate`}
                      className={vatSelectClass}
                      {...fieldErrorProps(`line-${index}-vat-rate`, !!bladStawki(index))}
                      {...form.register(`lines.${index}.vatRate`)}
                    >
                      <option value="23">23%</option>
                      <option value="8">8%</option>
                      <option value="5">5%</option>
                      <option value="0">0%</option>
                      <option value="zw">zw — zwolniona</option>
                      <option value="oo">oo — odwrotne obciążenie</option>
                      <option value="np">np — nie podlega</option>
                      <option value="np_ii">np. II (usługa dla firmy z UE)</option>
                    </select>
                  </div>
                  {bladStawki(index) ? (
                    <FieldErrorText fieldId={`line-${index}-vat-rate`} className="col-span-2 mt-0">
                      {bladStawki(index)}
                    </FieldErrorText>
                  ) : null}
                </div>

                <div className="border-border flex items-center justify-between border-t pt-3">
                  <span className="text-muted-foreground text-xs">Brutto</span>
                  <div className="text-right">
                    <p className="text-base font-semibold tabular-nums">
                      {formatPlMoney(calc.grossAmount)} zł
                    </p>
                    <p className="text-muted-foreground text-xs tabular-nums">
                      Netto: {formatPlMoney(calc.netAmount)} zł
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Button type="button" variant="secondary" size="sm" onClick={onAddLine}>
        <RiAddLine />
        Dodaj pozycję
      </Button>
    </DocumentSection>
  );
}
