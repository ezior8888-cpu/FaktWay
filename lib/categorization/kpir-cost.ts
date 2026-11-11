/**
 * Kwota kosztu w KPiR dla wydatku.
 *
 * Koszt to netto + VAT, którego podatnikowi NIE WOLNO odliczyć
 * (art. 23 ust. 1 pkt 43 lit. a ustawy o PIT): paragon, firma zwolniona
 * z VAT, samochód 50%. VAT, który wolno było odliczyć, kosztem nie jest —
 * faktura czynnego podatnika zostaje w KPiR po netto.
 *
 * Do 27.09 KPiR brał netto zawsze: paragon za 1 230 zł (230 zł VAT) szedł
 * jako 1 000 zł kosztu, a klient przepłacał podatek dochodowy.
 */

import { roundToCents } from '@/lib/xml/invoice-calculator';

/**
 * Rodzaje dokumentów, z których czynny podatnik odlicza VAT. JPK_V7M i kafle
 * liczą odliczenie regułą `documentAllowsVatDeduction` (rodzaj i data: paragon
 * z NIP tylko do 31.12.2026). Koszt w PIT (`nonDeductedVat`) celowo bierze sam
 * rodzaj, więc paragon z NIP z 2027 r. zostaje kosztem netto jak dotąd, do
 * odpowiedzi księgowej (krok 1.3 planu kompletnej aplikacji).
 */
export const VAT_DEDUCTIBLE_DOCUMENTS: ReadonlySet<string> = new Set(['invoice', 'simplified_invoice']);

export interface KpirCostInput {
  net_amount: number | string | null;
  vat_amount: number | string | null;
  vat_deductible_amount: number | string | null;
  document_type: string | null;
}

/**
 * VAT z dokumentu, którego nie odliczamy — wchodzi w koszt.
 *
 * Ze znakiem: korekta zakupu „in minus” (#68) ma ujemny VAT, a bez prawa do
 * odliczenia (np. firma zwolniona) ma obniżyć koszt o brutto, nie o netto.
 */
export function nonDeductedVat(e: KpirCostInput): number {
  const vat = Number(e.vat_amount ?? 0);
  if (!Number.isFinite(vat) || vat === 0) return 0;
  const raw = VAT_DEDUCTIBLE_DOCUMENTS.has(e.document_type ?? 'invoice')
    ? Number(e.vat_deductible_amount ?? 0)
    : 0;
  // Odliczenie ma znak VAT-u i nie przekracza go co do wartości.
  const deducted = vat > 0 ? Math.min(vat, Math.max(0, raw)) : Math.max(vat, Math.min(0, raw));
  return round2(vat - deducted);
}

export function kpirCostAmount(e: KpirCostInput): number {
  return round2(Number(e.net_amount ?? 0) + nonDeductedVat(e));
}

function round2(n: number): number {
  return roundToCents(n);
}
