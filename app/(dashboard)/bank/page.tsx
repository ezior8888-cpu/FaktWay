import type { SupabaseClient } from '@supabase/supabase-js';

import { BankView } from '@/components/bank/bank-view';
import { matchInvoice, type MatchResult } from '@/lib/import/bank/dopasowanie';
import { parseBankOperationsRpc } from '@/lib/import/bank/ekran';
import { loadOpenSalesInvoices, type BankInvoiceOption } from '@/lib/import/bank/kandydaci';
import { TAX_LOAD_FAILED, type PrzelewyPodatkoweEkranu } from '@/lib/import/bank/podatki';
import { czytajPrzelewyPodatkowe } from '@/lib/import/bank/podatki-dane';
import { canChangeInvoicePayment } from '@/lib/invoices/manual-payment';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { getPageContext } from '@/lib/supabase/page-context';

export const dynamic = 'force-dynamic';

type RpcResult = PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
/** `bank_operations` z 00180; do czasu typów z produkcji przez ten kształt. */
interface BankReadRpc {
  rpc(fn: 'bank_operations'): RpcResult;
}

/**
 * Ekran „Bank” (plan kompletnej aplikacji, krok 3.2, część 1; wzór P12
 * z PLAN-FINORA.md): wgranie wyciągu, wpływy do sprawdzenia z propozycją
 * faktury, ostatnie decyzje. Odczyt klientem sesji: operacje przez RPC
 * `bank_operations` (tabela zamknięta dla sesji, 00074), niezapłacone faktury
 * przez RLS. Propozycje liczy serwer przy każdym wejściu (`matchInvoice`), więc
 * faktura zapłacona w międzyczasie znika z propozycji.
 *
 * Fail-closed: błąd odczytu operacji to komunikat zamiast pustej listy; błąd
 * odczytu faktur to brak propozycji i wyboru faktury, z komunikatem, ale
 * „Pomiń” działa.
 *
 * Krok 3.2, część 2: przy włączonym module księgowości (obszar `ten_miesiac`)
 * sekcja „Zapłaty do ZUS i urzędu skarbowego” z propozycją rozliczenia dla
 * przelewów podatkowych (`czytajPrzelewyPodatkowe`); bez modułu jej nie ma.
 */
export default async function BankPage() {
  const { supabase, tenantId, role } = await getPageContext();
  const environment = requireConfiguredKsefEnvironment();

  const taxRead: Promise<PrzelewyPodatkoweEkranu | null> = czytajPrzelewyPodatkowe(supabase as unknown as SupabaseClient, tenantId).catch(
    (error: unknown) => {
      console.error('[bank] przelewy podatkowe', error instanceof Error ? error.message : 'błąd');
      return { ok: false as const, error: TAX_LOAD_FAILED };
    },
  );
  const rpc = await (supabase as unknown as BankReadRpc).rpc('bank_operations');
  if (rpc.error) console.error('[bank] bank_operations', rpc.error.code);
  const data = rpc.error ? null : parseBankOperationsRpc(rpc.data);

  let invoices: BankInvoiceOption[] | null = [];
  if (data && data.pending.length > 0) {
    invoices = await loadOpenSalesInvoices(supabase, tenantId, environment).catch((error: unknown) => {
      console.error('[bank] faktury do dopasowania', error instanceof Error ? error.message : 'błąd');
      return null;
    });
  }

  const proposals: Record<string, MatchResult> = {};
  if (data && invoices) {
    for (const op of data.pending) proposals[op.id] = matchInvoice(op, invoices);
  }

  return (
    <BankView
      data={data}
      invoices={invoices}
      proposals={proposals}
      canWrite={canChangeInvoicePayment(role)}
      tax={await taxRead}
      canWriteTax={role === 'owner' || role === 'admin'}
    />
  );
}
