/**
 * Zapłata spoza wyliczenia (plan księgowości JDG, K7.2, decyzja D15):
 * składki ZUS zapłacone za okres, którego moduł nie liczy (np. za grudzień
 * 2025 r. albo niepełny miesiąc), z kwotą z PUE ZUS. Zapis to wersja
 * rozliczenia w `tax_settlements` z `migawka.reczna`, więc odliczenia,
 * historia i „Cofnij zapłatę” działają jak przy wyliczonej kwocie, a późniejsze
 * wyliczenie tego samego okresu dolicza tylko różnicę (`przyrostyZaplat`).
 *
 * Ten sam schemat Zod sprawdza formularz i akcję serwerową.
 */

import { z } from 'zod';

import { kwotaNaGrosze } from '@/lib/ksiegowosc/wpisy-reczne';

export const RODZAJE_ZAPLATY_RECZNEJ = ['zus_spoleczne', 'zdrowotna'] as const;
export type RodzajZaplatyRecznej = (typeof RODZAJE_ZAPLATY_RECZNEJ)[number];

/** Najwcześniejszy okres zapłaty spoza wyliczenia (RRRR-MM; 00172). */
export const ZAPLATA_RECZNA_OD = '2025-01';

const kwotaDodatnia = z.string().transform((v, ctx) => {
  const gr = kwotaNaGrosze(v);
  if (gr === null || gr <= 0) {
    ctx.addIssue({ code: 'custom', message: 'Kwota to liczba większa od zera, z najwyżej dwoma miejscami po przecinku.' });
    return z.NEVER;
  }
  return gr;
});

export const zaplataRecznaSchema = z
  .object({
    zaMiesiac: z
      .string()
      .regex(/^20\d{2}-(0[1-9]|1[0-2])$/, 'Brak miesiąca, za który są składki.')
      .refine((v) => v >= ZAPLATA_RECZNA_OD, { message: 'Zapłatę spoza wyliczenia zapisuje się za okresy od stycznia 2025 r.' }),
    rodzaj: z.enum(RODZAJE_ZAPLATY_RECZNEJ, { message: 'Brak rodzaju składek.' }),
    kwota: kwotaDodatnia,
    /** Składki społeczne: część bez Funduszu Pracy i FS (odlicza się od przychodu albo dochodu). */
    bezFp: z.string(),
    dataZaplaty: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Brak daty zapłaty.'),
  })
  .transform((w, ctx) => {
    let bezFpGr = 0;
    if (w.rodzaj === 'zus_spoleczne') {
      const gr = kwotaNaGrosze(w.bezFp);
      if (gr === null || gr < 0) {
        ctx.addIssue({ code: 'custom', path: ['bezFp'], message: 'Część bez Funduszu Pracy to kwota z DRA (pozycja składek na ubezpieczenia społeczne).' });
        return z.NEVER;
      }
      if (gr > w.kwota) {
        ctx.addIssue({ code: 'custom', path: ['bezFp'], message: 'Część bez Funduszu Pracy nie może być większa niż cała zapłacona kwota.' });
        return z.NEVER;
      }
      bezFpGr = gr;
    }
    if (w.dataZaplaty < `${w.zaMiesiac}-01`) {
      ctx.addIssue({ code: 'custom', path: ['dataZaplaty'], message: 'Data zapłaty nie może być wcześniejsza niż miesiąc, za który są składki.' });
      return z.NEVER;
    }
    return { zaMiesiac: w.zaMiesiac, rodzaj: w.rodzaj, kwotaGr: w.kwota, bezFpGr, dataZaplaty: w.dataZaplaty };
  });

export type ZaplataRecznaWejscie = z.input<typeof zaplataRecznaSchema>;
export type ZaplataReczna = z.output<typeof zaplataRecznaSchema>;

/** Wejścia wersji ręcznej (skrót D6 liczy się z nich i z kwoty). */
export function wejsciaZaplatyRecznej(z: ZaplataReczna): Record<string, unknown> {
  return { reczna: true, kwotaGr: z.kwotaGr, spoleczneBezFpGr: z.bezFpGr };
}
