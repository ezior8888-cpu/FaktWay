/**
 * Stan faktur na czas danych przykładowych (M2, M3): oznaczenie zapłaty jest
 * wspólne dla listy i szczegółu. Etap M6 zastąpi to danymi z bazy, a M9
 * zapisem przez API (`markInvoicePaidAction` po stronie strony).
 */
import { createContext, use, useMemo, useState, type ReactNode } from 'react';

import { FAKTURY, type Faktura } from '@/dane-przykladowe';

/** Warianty miejsca „Nowa faktura” do decyzji D7 (plan, sekcja 2). */
export type WariantNowej = 'pasek' | 'pod-suma' | 'nad-zakladkami';

type Stan = {
  faktury: Faktura[];
  ustawZaplate: (id: string, zaplacona: boolean) => void;
  wariantNowej: WariantNowej;
  ustawWariantNowej: (w: WariantNowej) => void;
};

const Kontekst = createContext<Stan | null>(null);

export function StanFaktur({ children }: { children: ReactNode }) {
  const [zaplacone, setZaplacone] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(FAKTURY.map((f) => [f.id, f.zaplacona])),
  );
  const [wariantNowej, ustawWariantNowej] = useState<WariantNowej>('pasek');

  const wartosc = useMemo<Stan>(
    () => ({
      faktury: FAKTURY.map((f) => ({ ...f, zaplacona: zaplacone[f.id] ?? f.zaplacona })),
      ustawZaplate: (id, zaplacona) => setZaplacone((z) => ({ ...z, [id]: zaplacona })),
      wariantNowej,
      ustawWariantNowej,
    }),
    [zaplacone, wariantNowej],
  );

  return <Kontekst value={wartosc}>{children}</Kontekst>;
}

export function useStanFaktur(): Stan {
  const stan = use(Kontekst);
  if (!stan) throw new Error('useStanFaktur poza <StanFaktur>');
  return stan;
}
