/**
 * Zwolnienie z VAT — podstawa prawna na poziomie firmy.
 *
 * Firma zwolniona (podmiotowo z art. 113 albo przedmiotowo z art. 43) wystawia
 * faktury ze stawką „zw”, a FA(3) wymaga wtedy P_19 = 1 i JEDNEJ podstawy
 * prawnej (P_19A — przepis ustawy). Do 26.09 formularz nie miał „zw”,
 * a generator rzucał błędem — firma zwolniona albo nie wystawiała faktury,
 * albo wybierała „0%”/„np”, czyli stawkę niezgodną z przepisami.
 *
 * Kolumna `tenants.vat_exemption_basis` (migracja 00091): NULL = czynny
 * podatnik VAT.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/** Najczęstsze podstawy — reszta (np. art. 43 ust. 1 pkt …) jako tekst własny. */
export const VAT_EXEMPTION_PRESETS = [
  {
    value: 'art. 113 ust. 1 ustawy o VAT',
    label: 'Zwolnienie podmiotowe — sprzedaż do 240 000 zł rocznie (art. 113 ust. 1)',
  },
  {
    value: 'art. 113 ust. 9 ustawy o VAT',
    label: 'Zwolnienie podmiotowe — działalność rozpoczęta w tym roku (art. 113 ust. 9)',
  },
] as const;

/**
 * Podstawa po oczyszczeniu albo `null` („czynny podatnik VAT”). Te same
 * granice co CHECK w 00091: 3–256 znaków, bez znaków sterujących.
 */
export function normalizeExemptionBasis(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim().replace(/\s+/g, ' ');
  if (value.length === 0) return null;
  if (value.length < 3 || value.length > 256) {
    throw new Error('Podstawa zwolnienia musi mieć od 3 do 256 znaków.');
  }
  if (/[\u0000-\u001f\u007f<>]/.test(value)) {
    throw new Error('Podstawa zwolnienia zawiera niedozwolone znaki.');
  }
  return value;
}

/**
 * Zwolnienie PODMIOTOWE (art. 113): firma nie jest czynnym podatnikiem VAT,
 * więc nie odlicza VAT-u od kosztów i nie stosuje metody kasowej.
 *
 * Podstawa z art. 43 (sprzedaż zwolniona przedmiotowo) tego nie znaczy —
 * czynny podatnik ze sprzedażą zwolnioną zachowuje odliczenie (decyzja I2,
 * AUD-68). Do 02.10 każda podstawa zerowała odliczenie i wyłączała P_16.
 */
export function isSubjectiveVatExemption(basis: string | null | undefined): boolean {
  return typeof basis === 'string' && /\bart\.?\s*113\b/i.test(basis);
}

/**
 * Stawki, od których na fakturze powstaje podatek do zapłaty (art. 108 ust. 1
 * ustawy o VAT): 23, 8 i 5 %. Bez 0 %, „zw”, „np” i odwrotnego obciążenia.
 */
export const TAXED_VAT_RATES: readonly string[] = ['23', '8', '5'];

/**
 * Pierwsza stawka z podatkiem na fakturze firmy zwolnionej PODMIOTOWO
 * (art. 113); `null` dla czynnego podatnika, zwolnienia przedmiotowego
 * (art. 43) i faktury bez takiej stawki (F12-G6 i G6b).
 */
export function taxedRateUnderSubjectiveExemption(
  basis: string | null | undefined,
  rates: readonly string[],
): string | null {
  if (!isSubjectiveVatExemption(basis)) return null;
  return rates.find((r) => TAXED_VAT_RATES.includes(r)) ?? null;
}

/** Odmowa wysyłki (F12-G6b): faktura ze stawką z podatkiem od firmy zwolnionej z art. 113. */
export function exemptTenantTaxedInvoiceMessage(documentNumber: string, rate: string): string {
  return (
    `Faktura ${documentNumber} ma stawkę VAT ${rate} %, a firma korzysta ze zwolnienia z VAT (art. 113). ` +
    'Na takiej fakturze VAT trzeba by zapłacić (art. 108 ust. 1 ustawy o VAT). Zmień stawkę na „zw” ' +
    'albo, jeśli zwolnienie już nie obowiązuje, status VAT w ustawieniach firmy.'
  );
}

/** Kod PostgREST/Postgres „nie ma takiej kolumny” — przed wgraniem 00091. */
const UNDEFINED_COLUMN = '42703';

/**
 * Odczyt odporny na kolejność wdrożenia: gdyby kod trafił na produkcję przed
 * migracją, brak kolumny znaczy „nie zwolniona”, a nie wywrócona strona.
 * Każdy inny błąd — rzuca (błąd to nie „czynny podatnik”).
 */
export async function readTenantVatExemption(
  client: SupabaseClient,
  tenantId: string,
): Promise<string | null> {
  const { data, error } = await client
    .from('tenants')
    .select('vat_exemption_basis')
    .eq('id', tenantId)
    .maybeSingle();
  if (error) {
    if (error.code === UNDEFINED_COLUMN) return null;
    throw new Error(`Nie można odczytać ustawień VAT firmy: ${error.message}`);
  }
  const raw = (data as { vat_exemption_basis?: unknown } | null)?.vat_exemption_basis;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}
