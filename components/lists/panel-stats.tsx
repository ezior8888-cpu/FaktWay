import type { ReactNode } from 'react';

export interface PanelStat {
  label: string;
  value: string;
  /** Podpis pod liczbą: zakres, zastrzeżenie. */
  note?: ReactNode;
}

/**
 * Pasek liczb nad tabelą, w karcie sekcji. Zastępuje kafle właściwe jednej
 * zakładce (decyzja Bartosza 25.10.2026: kafle są jedne dla całej sekcji,
 * a liczby zakładki stoją przy jej tabeli), żeby przełączenie zakładki nie
 * zmieniało niczego nad kartą.
 */
export function PanelStats({ label, items }: { label: string; items: readonly PanelStat[] }) {
  return (
    <dl aria-label={label} className="grid grid-cols-2 gap-x-4 gap-y-3 border-b px-4 pt-2 pb-4 lg:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-muted-foreground text-xs">{item.label}</dt>
          <dd className="text-foreground text-lg font-medium tabular-nums">{item.value}</dd>
          {item.note ? <dd className="text-muted-foreground text-xs">{item.note}</dd> : null}
        </div>
      ))}
    </dl>
  );
}
