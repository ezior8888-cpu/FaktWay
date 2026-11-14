'use server';

import { revalidatePath } from 'next/cache';

import type { createClient } from '@/lib/supabase/server';
import { requireUserAndActiveOrg, type FormTenantCheck } from '@/lib/supabase/auth-context';
import { lookupCompanyByNip } from '@/lib/gus/client';
import { formatJobSendError } from '@/lib/jobs/error-message';
import { validateNipChecksum } from '@/lib/xml/invoice-calculator';
import type { TenantSnapshot } from '@/lib/invoices/build-from-form';
import {
  parseRegularInvoiceForm,
  readTenantSnapshot,
  saveAndSendRegularInvoice,
  saveRegularDraft,
  type RegularIssueResult,
} from '@/lib/invoices/issue-regular';
import { addressCountryForKodUE, parseVatUe } from '@/lib/invoices/vat-ue';
import { RECURRING_DRAFT_REFUSED_MESSAGE } from '@/lib/invoices/recurring/issue';
import { suggestNextInvoiceNumberForTenant } from '@/lib/invoices/next-number';
import { addDaysToIsoDate, dueDateFrom, todayInWarsaw } from '@/lib/format/warsaw-date';
import { EU_BUYER_COUNTRIES, type InvoiceFormValues } from '@/lib/schemas/invoice-form';
import type { Invoice } from '@/types/invoice';

// ═══════════════════════════════════════════════════════════════
// Helpery tenant / snapshot faktury
// ═══════════════════════════════════════════════════════════════

/** Pobiera kontekst zalogowanego usera + jego tenanta.
 *  Rzuca wyjątek jeśli user niezalogowany lub bez tenanta - powinien
 *  wtedy być na `/onboarding`, wejście na formularz z `null` to bug.
 *  `formTenant` — zapis dokumentu z formularza: firma formularza musi być
 *  firmą aktywną teraz (UX-01). */
async function getTenantContext(formTenant?: FormTenantCheck): Promise<{
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string;
  tenant: TenantSnapshot;
}> {
  // This action boundary enforces MFA and current membership independently of routing.
  const { supabase, user, tenantId } = await requireUserAndActiveOrg(formTenant);
  return { supabase, userId: user.id, tenant: await readTenantSnapshot(supabase, tenantId) };
}

// ═══════════════════════════════════════════════════════════════
// lookupBuyerAction - cache kontrahentów + GUS fallback
// ═══════════════════════════════════════════════════════════════

export type LookupBuyerResult =
  | {
      success: true;
      source: 'cache' | 'gus';
      data: {
        nip: string;
        name: string;
        addressLine1: string;
        addressLine2: string;
      };
    }
  | { success: false; error: string };

interface ContractorAddress {
  countryCode?: string;
  addressLine1?: string;
  addressLine2?: string;
}

export async function lookupBuyerAction(
  nip: string
): Promise<LookupBuyerResult> {
  if (!/^\d{10}$/.test(nip)) {
    return { success: false, error: 'NIP musi zawierać 10 cyfr' };
  }
  if (!validateNipChecksum(nip)) {
    return { success: false, error: 'Nieprawidłowa suma kontrolna NIP' };
  }

  let supabase: Awaited<ReturnType<typeof createClient>>;
  let tenantId: string;
  try {
    const ctx = await getTenantContext();
    supabase = ctx.supabase;
    tenantId = ctx.tenant.id;
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Brak kontekstu tenanta',
    };
  }

  // 1) Cache - lokalna tabela `contractors` (per tenant).
  const { data: cached } = await supabase
    .from('contractors')
    .select('nip, name, address')
    .eq('tenant_id', tenantId)
    .eq('nip', nip)
    .maybeSingle();

  if (cached) {
    const addr = (cached.address as ContractorAddress | null) ?? {};
    // Update last_used_at żeby rozpinać "ostatnio używane" w przyszłym UI.
    await supabase
      .from('contractors')
      .update({ last_used_at: new Date().toISOString() })
      .eq('tenant_id', tenantId)
      .eq('nip', nip);

    return {
      success: true,
      source: 'cache',
      data: {
        nip: cached.nip as string,
        name: cached.name as string,
        addressLine1: addr.addressLine1 ?? '',
        addressLine2: addr.addressLine2 ?? '',
      },
    };
  }

  // 2) Fallback: GUS REGON.
  const gus = await lookupCompanyByNip(nip);
  if (gus.kind === 'not-found') {
    return {
      success: false,
      error: 'Nie znaleziono firmy w GUS. Sprawdź numer NIP.',
    };
  }
  if (gus.kind === 'error') {
    return {
      success: false,
      error:
        'GUS chwilowo niedostępny. Spróbuj ponownie za chwilę lub uzupełnij dane ręcznie.',
    };
  }

  const addressLine1 = `${gus.data.street} ${gus.data.buildingNumber}${
    gus.data.localNumber ? '/' + gus.data.localNumber : ''
  }`.trim();
  const addressLine2 = `${gus.data.postalCode} ${gus.data.city}`.trim();

  // Zapisz w cache (upsert po unique (tenant_id, nip)). Używamy fire-and-forget
  // bez przerywania flow jeśli cache padnie - user i tak dostanie dane.
  await supabase.from('contractors').upsert(
    {
      tenant_id: tenantId,
      nip: gus.data.nip,
      name: gus.data.name,
      address: {
        countryCode: 'PL',
        addressLine1,
        addressLine2,
      },
      last_used_at: new Date().toISOString(),
    },
    { onConflict: 'tenant_id,nip' }
  );

  return {
    success: true,
    source: 'gus',
    data: {
      nip: gus.data.nip,
      name: gus.data.name,
      addressLine1,
      addressLine2,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// Budowanie pełnego obiektu Invoice z InvoiceFormValues: `buildInvoiceFromForm`
// i kolumny szkicu w `lib/invoices/build-from-form.ts` (ta sama droga dla
// publicznego API, krok 7.1). Zapis szkicu, faktury cyklicznej i z proformy
// oraz kolejka KSeF: `lib/invoices/issue-regular.ts` (ta sama droga dla
// aplikacji na telefon, M8).
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// saveDraftAction / saveAndSendInvoiceAction
// ═══════════════════════════════════════════════════════════════

/** `invoiceId` przy odmowie — zapisany szkic (np. brak certyfikatu KSeF; user może do niego wrócić). */
export type InvoiceActionResult = RegularIssueResult;

/**
 * `expectedTenantId` — firma, dla której strona wyrenderowała formularz
 * (UX-01). Tylko do porównania z firmą z ciasteczka; firmą dokumentu jest
 * firma z sesji. Dotyczy też `saveAndSendInvoiceAction`.
 */
export async function saveDraftAction(
  values: InvoiceFormValues,
  expectedTenantId: string,
): Promise<InvoiceActionResult> {
  // C2 (E9): z pozycji cyklicznej nie ma szkicu. Szkic zajmowałby okres
  // i przesuwał harmonogram, a nazajutrz nie dałby się wysłać (data
  // wystawienia ≠ dziś) — formularz chowa „Zapisz szkic”, a tu odmowa dla
  // wywołania wprost. Bez zapisu i bez odczytu bazy.
  if (values?.recurringInvoiceId) return { success: false, error: RECURRING_DRAFT_REFUSED_MESSAGE };
  // Ten sam schemat co formularz i „Wystaw i wyślij” — szkic da się później
  // wysłać do KSeF (F-042), więc nie może omijać walidacji wywołaniem wprost.
  const parsed = parseRegularInvoiceForm(values);
  if (!parsed.ok) return { success: false, error: parsed.error };
  try {
    // Logika szkicu: `saveRegularDraft` (lib/invoices/issue-regular.ts), ta sama dla telefonu (M8).
    const result = await saveRegularDraft(await getTenantContext({ expectedTenantId }), values);
    if (result.success && result.invoiceId) revalidatePath('/invoices');
    return result;
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Nieznany błąd',
    };
  }
}

export async function saveAndSendInvoiceAction(
  values: InvoiceFormValues,
  expectedTenantId: string,
): Promise<InvoiceActionResult> {
  // Ten sam schemat co formularz (AGENTS.md: walidacja klient + serwer). Bez
  // tego wszystko, co pilnuje formularz — NIP z sumą kontrolną, pozycje, MPP
  // z rachunkiem — dało się ominąć wywołaniem akcji wprost.
  const parsed = parseRegularInvoiceForm(values);
  if (!parsed.ok) return { success: false, error: parsed.error };
  try {
    // Logika wystawienia i kolejki: `saveAndSendRegularInvoice`
    // (lib/invoices/issue-regular.ts), ta sama dla telefonu (M8).
    return await saveAndSendRegularInvoice(await getTenantContext({ expectedTenantId }), values);
  } catch (err) {
    return {
      success: false,
      error:
        err instanceof Error
          ? formatJobSendError(err)
          : 'Nieznany błąd wysyłki',
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// Wypełnienie z ostatniej faktury (podpowiedź Flo na `/invoices/new`)
// ═══════════════════════════════════════════════════════════════

/** Wartości do wstrzyknięcia w formularz — bez numeru i bez dat. */
export interface PrefillFromLastInvoice {
  contractorName: string;
  values: Pick<
    InvoiceFormValues,
    | 'buyerNip'
    | 'buyerIsEu'
    | 'buyerVatUe'
    | 'buyerCountryCode'
    | 'buyerName'
    | 'buyerAddressLine1'
    | 'buyerAddressLine2'
    | 'buyerEmail'
    | 'lines'
    | 'paymentMethod'
    | 'bankAccount'
  >;
}

/**
 * Ostatnia wystawiona faktura tego tenanta jako podkład pod nową.
 *
 * CZEGO TU CELOWO NIE MA: numeru faktury, daty wystawienia, daty sprzedaży
 * i terminu płatności. Numer musi być nowy, a przepisanie starych dat to
 * najprostszy sposób na wystawienie faktury z datą sprzed miesiąca — błąd,
 * którego klient nie zauważy, dopóki nie zrobi tego księgowa.
 *
 * `direction = 'outgoing'`. Kolumna `invoices.direction` przyjmuje WYŁĄCZNIE
 * `'outgoing' | 'incoming'`; wpisanie tam `'issued'` cicho zwraca zero wierszy
 * i nie rzuca błędem — dokładnie tak przez wiele miesięcy wszystkie karty KPI
 * dashboardu pokazywały zera (`docs/flo/UKLAD-DASHBOARDU.md`).
 *
 * Odczyt idzie klientem z sesji, więc RLS pilnuje tenanta; `eq('tenant_id')`
 * jest drugą warstwą, nie jedyną.
 */
export async function prefillFromLastInvoiceAction(): Promise<PrefillFromLastInvoice | null> {
  let supabase: Awaited<ReturnType<typeof createClient>>;
  let tenantId: string;
  try {
    const ctx = await getTenantContext();
    supabase = ctx.supabase;
    tenantId = ctx.tenant.id;
  } catch {
    return null;
  }

  const { data: ostatnia } = await supabase
    .from('invoices')
    .select('id, fa3_data')
    .eq('tenant_id', tenantId)
    .eq('direction', 'outgoing')
    .order('issue_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!ostatnia) return null;
  return prefillCore(supabase, ostatnia);
}

/**
 * Wspólny rdzeń podkładu (ostatnia faktura i wskazana faktura): nabywca,
 * pozycje i sposób zapłaty z faktury `row` tej firmy. Bez numeru i bez dat —
 * zasady w opisie `prefillFromLastInvoiceAction`. `null`, gdy faktura nie ma
 * nabywcy albo czytelnych pozycji.
 */
async function prefillCore(
  supabase: Awaited<ReturnType<typeof createClient>>,
  row: { id: string; fa3_data: unknown },
): Promise<PrefillFromLastInvoice | null> {
  if (!row.fa3_data) return null;

  const faktura = row.fa3_data as Invoice;
  const buyer = faktura.buyer;
  if (!buyer?.name) return null;

  const { data: pozycje } = await supabase
    .from('invoice_line_items')
    .select('ordinal, name, unit, quantity, unit_price_net, vat_rate')
    .eq('invoice_id', row.id)
    .order('ordinal', { ascending: true });

  const lines = (pozycje ?? [])
    .map((poz) => ({
      name: String(poz.name ?? ''),
      unit: String(poz.unit ?? 'szt'),
      quantity: Number(poz.quantity) || 0,
      unitPriceNet: Number(poz.unit_price_net) || 0,
      vatRate: String(poz.vat_rate ?? '23'),
    }))
    .filter((poz) => poz.name.length > 0 && poz.quantity > 0);

  // Faktura bez czytelnych pozycji nie jest podkładem, tylko pułapką:
  // klient kliknąłby „Wypełnij" i dostał pusty formularz z samym nabywcą.
  if (lines.length === 0) return null;

  // AUD-70: nabywca z UE wraca jako firma z UE — sam pusty NIP zostawiłby
  // formularz z błędem „NIP firmy”, a numer VAT-UE przepadłby po drodze.
  // Kraj adresu ze starej faktury tylko z listy formularza; inaczej z prefiksu.
  const vatUe = parseVatUe(buyer.vatUeNumber);
  const krajAdresu = buyer.address?.countryCode ?? '';
  const nabywcaUe =
    vatUe && vatUe.kodUE !== 'PL'
      ? {
          buyerIsEu: true,
          buyerVatUe: vatUe.normalized,
          buyerCountryCode: EU_BUYER_COUNTRIES.some((k) => k.code === krajAdresu)
            ? krajAdresu
            : addressCountryForKodUE(vatUe.kodUE),
        }
      : null;

  return {
    contractorName: buyer.name,
    values: {
      buyerNip: !nabywcaUe && 'nip' in buyer && buyer.nip ? buyer.nip : '',
      ...nabywcaUe,
      buyerName: buyer.name,
      buyerAddressLine1: buyer.address?.addressLine1 ?? '',
      buyerAddressLine2: buyer.address?.addressLine2 ?? '',
      buyerEmail: buyer.email ?? '',
      lines: lines as InvoiceFormValues['lines'],
      // „mobile” ma tylko faktura za abonament opłacony BLIK-iem; formularz tej formy nie zna.
      paymentMethod: faktura.payment?.method === 'mobile' ? 'other' : faktura.payment?.method ?? 'transfer',
      bankAccount: faktura.payment?.bankAccount ?? '',
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// Wypełnienie ze wskazanej faktury („Duplikuj”, „Wystaw teraz” z faktury
// cyklicznej — plan Finora N1)
// ═══════════════════════════════════════════════════════════════

/** Gdy terminu płatności wzoru nie da się odczytać — 14 dni, jak w pustym formularzu. */
const DEFAULT_PAYMENT_DAYS = 14;
/** Termin dłuższy niż rok z dawnej faktury traktujemy jak brak (błędna data), nie przepisujemy. */
const MAX_PAYMENT_DAYS = 365;

/** Podkład ze wskazanej faktury: wartości gotowe do `defaultValues` formularza. */
export interface PrefillFromInvoice {
  invoiceId: string;
  contractorName: string;
  /** Numer faktury, z której wypełniamy — do podpisu „na podstawie FV …”. */
  sourceNumber: string | null;
  values: PrefillFromLastInvoice['values'] &
    Pick<
      InvoiceFormValues,
      | 'internalNumber'
      | 'issueDate'
      | 'saleDate'
      | 'paymentDueDate'
      | 'buyerIsConsumer'
      | 'buyerConsumerIdType'
      | 'buyerPesel'
      | 'buyerIdDocument'
      | 'splitPayment'
    >;
}

/** Dni terminu płatności wzoru: `days_to_payment`, a bez niego różnica termin − data wystawienia. */
function paymentDaysOf(row: {
  days_to_payment: number | null;
  issue_date: string | null;
  payment_due_date: string | null;
}): number | null {
  const ok = (d: number) => Number.isInteger(d) && d >= 0 && d <= MAX_PAYMENT_DAYS;
  if (typeof row.days_to_payment === 'number' && ok(row.days_to_payment)) return row.days_to_payment;
  if (!row.issue_date || !row.payment_due_date) return null;
  if (!addDaysToIsoDate(row.issue_date, 0) || !addDaysToIsoDate(row.payment_due_date, 0)) return null;
  const dni = Math.round(
    (Date.parse(`${row.payment_due_date}T00:00:00Z`) - Date.parse(`${row.issue_date}T00:00:00Z`)) / 86_400_000,
  );
  return ok(dni) ? dni : null;
}

const CONSUMER_ID_TYPES = ['pesel', 'id_card', 'passport', 'no_id'] as const;
type ConsumerIdType = (typeof CONSUMER_ID_TYPES)[number];

/**
 * Wskazana faktura sprzedaży tej firmy jako podkład pod nową — uogólnienie
 * `prefillFromLastInvoiceAction` na konkretną fakturę (plan Finora N1).
 *
 * Te same zasady: treść (nabywca, pozycje, sposób zapłaty) ze wzoru, ale
 * NIGDY jego numer ani daty. Numer podpowiada `suggestNextInvoiceNumberForTenant`,
 * data wystawienia i sprzedaży to dziś (Europe/Warsaw), termin płatności to
 * dziś + tyle dni, ile miał wzór. Klient może wszystko poprawić przed „Wystaw
 * i wyślij do KSeF” — akcja niczego nie zapisuje.
 *
 * Osoba prywatna wraca jako osoba prywatna (rodzaj i numer dokumentu z kolumn
 * faktury), żeby faktura cykliczna dla konsumenta nie otwierała się z błędem
 * „NIP firmy”. MPP (P_18A) przechodzi ze wzoru.
 *
 * Odczyt klientem sesji (RLS) i z `eq('tenant_id')`; faktura obca, kosztowa
 * albo nieistniejąca daje `null` — strona pokazuje wtedy pusty formularz
 * z komunikatem.
 */
export async function prefillFromInvoiceAction(invoiceId: string): Promise<PrefillFromInvoice | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(invoiceId)) return null;

  let supabase: Awaited<ReturnType<typeof createClient>>;
  let tenantId: string;
  try {
    const ctx = await getTenantContext();
    supabase = ctx.supabase;
    tenantId = ctx.tenant.id;
  } catch {
    return null;
  }

  const { data: wzor } = await supabase
    .from('invoices')
    .select(
      'id, fa3_data, internal_number, issue_date, payment_due_date, days_to_payment, is_b2c, buyer_id_type, buyer_pesel, buyer_id_number',
    )
    .eq('id', invoiceId)
    .eq('tenant_id', tenantId)
    .eq('direction', 'outgoing')
    .maybeSingle();
  if (!wzor) return null;

  const core = await prefillCore(supabase, wzor);
  if (!core) return null;

  const dzis = todayInWarsaw();
  const numer = await suggestNextInvoiceNumberForTenant(supabase, tenantId, dzis);
  const dni = paymentDaysOf(wzor) ?? DEFAULT_PAYMENT_DAYS;
  const faktura = wzor.fa3_data as unknown as Invoice;

  const idType = wzor.buyer_id_type as string | null;
  const konsument: ConsumerIdType | null =
    wzor.is_b2c && !core.values.buyerIsEu
      ? CONSUMER_ID_TYPES.find((t) => t === idType) ?? 'no_id'
      : null;

  return {
    invoiceId: wzor.id,
    contractorName: core.contractorName,
    sourceNumber: wzor.internal_number ?? null,
    values: {
      ...core.values,
      ...(konsument ? { buyerNip: '' } : {}),
      internalNumber: numer ?? '',
      issueDate: dzis,
      saleDate: dzis,
      paymentDueDate: dueDateFrom(dzis, dni),
      buyerIsConsumer: konsument !== null,
      buyerConsumerIdType: konsument ?? undefined,
      buyerPesel: konsument === 'pesel' ? wzor.buyer_pesel ?? '' : '',
      buyerIdDocument:
        konsument === 'id_card' || konsument === 'passport' ? wzor.buyer_id_number ?? '' : '',
      splitPayment: faktura.annotations?.splitPayment === 1,
    },
  };
}
