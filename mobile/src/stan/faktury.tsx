/**
 * Stan faktur na czas danych przykładowych (M2, M3): oznaczenie zapłaty jest
 * wspólne dla listy i szczegółu. Etap M6 zastąpi to danymi z bazy, a M9
 * zapisem przez API (`markInvoicePaidAction` po stronie strony).
 */
import * as Haptics from 'expo-haptics';
import { createContext, use, useMemo, useState, type ReactNode } from 'react';
import { Share } from 'react-native';

import { FAKTURY, type Faktura } from '@/dane-przykladowe';
import { kwota } from '@/lib/format';

/** Warianty miejsca „Nowa faktura” do decyzji D7 (plan, sekcja 2). */
export type WariantNowej = 'pasek' | 'pod-suma' | 'nad-zakladkami';

type Stan = {
  faktury: Faktura[];
  /** Oznacza albo cofa zapłatę (z wibracją); jedno miejsce dla gestu, menu i przycisku. */
  przelaczZaplate: (f: Faktura) => void;
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
      przelaczZaplate: (f) => {
        setZaplacone((z) => ({ ...z, [f.id]: !f.zaplacona }));
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      },
      wariantNowej,
      ustawWariantNowej,
    }),
    [zaplacone, wariantNowej],
  );

  return <Kontekst value={wartosc}>{children}</Kontekst>;
}

/** Systemowy arkusz udostępniania z opisem faktury (PDF dochodzi w M9). */
export function udostepnijFakture(f: Faktura): void {
  void Share.share({ message: `Faktura ${f.numer} dla ${f.kontrahent}, ${kwota(f.brutto)}.` });
}

export function useStanFaktur(): Stan {
  const stan = use(Kontekst);
  if (!stan) throw new Error('useStanFaktur poza <StanFaktur>');
  return stan;
}
