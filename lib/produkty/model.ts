import { z } from 'zod';

import { vatRateEnum } from '@/lib/schemas/invoice-form';

/**
 * Katalog produktów i usług firmy (plan kompletnej aplikacji, krok 2.6, część 1)
 * na tabeli `products` (00013, unikalny klucz nazwa + jednostka z 00186).
 * Jeden schemat dla formularza (klient) i akcji zapisu (serwer): AGENTS.md,
 * „Formularze”. Granice jak w bazie: cena NUMERIC(15,2), reszta tekst.
 */

/** Stawki VAT jak w formularzu faktury: ta sama lista (`vatRateEnum`), nie nowa. */
export const PRODUCT_VAT_RATES = vatRateEnum.options;
export type ProductVatRate = (typeof PRODUCT_VAT_RATES)[number];

/** Etykiety stawek jak na PDF faktury; „np. II” jak w formularzu faktury. */
export const PRODUCT_VAT_RATE_LABELS: Record<ProductVatRate, string> = {
  '23': '23%',
  '8': '8%',
  '5': '5%',
  '0': '0%',
  zw: 'zw.',
  oo: 'o.o.',
  np: 'np.',
  np_ii: 'np. II',
};

/**
 * Kody GTU ze schematu FA(3) (`lib/xml/schemas/fa3/schemat-local.xsd`,
 * GTU_01 do GTU_13). Same kody, bez opisów: słownik opisów i reguły, kiedy
 * który kod się należy, to wiedza prawna i osobny krok planu (2.6, dalsze części).
 */
export const GTU_CODES = [
  'GTU_01', 'GTU_02', 'GTU_03', 'GTU_04', 'GTU_05', 'GTU_06', 'GTU_07',
  'GTU_08', 'GTU_09', 'GTU_10', 'GTU_11', 'GTU_12', 'GTU_13',
] as const;

export const PRODUCT_LIMITS = {
  name: 200,
  unit: 30,
  pkwiu: 20,
  description: 2000,
  /** Największa kwota netto: 12 cyfr przed przecinkiem (NUMERIC(15,2) ma zapas). */
  priceMax: 999_999_999_999.99,
} as const;

/** „1 250,50”, „1250.5”, 99.9 → liczba z najwyżej dwoma miejscami; inne wejście → null. */
export function parseProductPrice(raw: string | number): number | null {
  const clean = String(raw).replace(/[\s ]/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const value = Number(clean);
  return Number.isFinite(value) && value <= PRODUCT_LIMITS.priceMax ? value : null;
}

const PRICE_ERROR = 'Podaj cenę netto, na przykład 1250,00 (najwyżej dwa miejsca po przecinku, bez minusa).';

const priceSchema = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((raw, ctx) => {
    if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return null;
    const value = parseProductPrice(raw);
    if (value === null) {
      ctx.addIssue({ code: 'custom', message: PRICE_ERROR });
      return z.NEVER;
    }
    return value;
  });

/** Pole opcjonalne z walidacją: puste to null. */
function optional(max: number, label: string, pattern?: RegExp, patternMessage?: string) {
  return z
    .string()
    .nullish()
    .transform((raw, ctx) => {
      const value = (raw ?? '').trim();
      if (!value) return null;
      if (value.length > max) {
        ctx.addIssue({ code: 'custom', message: `${label}: najwyżej ${max} znaków.` });
        return z.NEVER;
      }
      if (pattern && !pattern.test(value)) {
        ctx.addIssue({ code: 'custom', message: patternMessage ?? `${label}: nieprawidłowa wartość.` });
        return z.NEVER;
      }
      return value;
    });
}

export const productFormSchema = z
  .object({
    name: z
      .string({ message: 'Podaj nazwę produktu lub usługi.' })
      .trim()
      .min(1, 'Podaj nazwę produktu lub usługi.')
      .max(PRODUCT_LIMITS.name, `Nazwa: najwyżej ${PRODUCT_LIMITS.name} znaków.`),
    unit: z
      .string({ message: 'Podaj jednostkę, na przykład szt. albo godz.' })
      .trim()
      .min(1, 'Podaj jednostkę, na przykład szt. albo godz.')
      .max(PRODUCT_LIMITS.unit, `Jednostka: najwyżej ${PRODUCT_LIMITS.unit} znaków.`),
    priceNet: priceSchema,
    vatRate: vatRateEnum,
    // Format PKWiU nie jest tu zgadywany: tylko znaki (cyfry i kropki) i długość.
    pkwiu: optional(PRODUCT_LIMITS.pkwiu, 'PKWiU', /^[0-9][0-9.]*$/, 'PKWiU: tylko cyfry i kropki, na przykład 62.01.11.0.'),
    gtu: z
      .string()
      .nullish()
      .transform((raw, ctx) => {
        const value = (raw ?? '').trim();
        if (!value) return null;
        if (!(GTU_CODES as readonly string[]).includes(value)) {
          ctx.addIssue({ code: 'custom', message: 'Wybierz kod GTU z listy albo zostaw pole puste.' });
          return z.NEVER;
        }
        return value;
      }),
    description: optional(PRODUCT_LIMITS.description, 'Opis'),
  })
  .transform((d) => ({
    name: d.name,
    unit: d.unit,
    defaultPriceNet: d.priceNet,
    defaultVatRate: d.vatRate,
    pkwiuCode: d.pkwiu,
    gtuCode: d.gtu,
    description: d.description,
  }));

/** Dane z formularza (przed walidacją). */
export type ProductFormInput = z.input<typeof productFormSchema>;
/** Dane po walidacji. */
export type ProductFormData = z.output<typeof productFormSchema>;

/** Wiersz katalogu dla listy. */
export interface ProductListItem {
  id: string;
  name: string;
  unit: string;
  defaultPriceNet: number | null;
  defaultVatRate: string;
  pkwiuCode: string | null;
  gtuCode: string | null;
  description: string | null;
  isArchived: boolean;
  useCount: number;
  lastUsedAt: string | null;
}

/** Komunikat dla zajętego klucza nazwa + jednostka (indeks 00186): z nazwą, bez błędu bazy. */
export function duplicateProductMessage(name: string, unit: string): string {
  return `Produkt „${name}” w jednostce „${unit}” już jest w katalogu. Zmień nazwę lub jednostkę albo edytuj istniejący wpis (może być zarchiwizowany).`;
}
