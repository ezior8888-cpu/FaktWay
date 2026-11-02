'use server';

import { revalidatePath } from 'next/cache';

import { logAudit } from '@/lib/audit/log';
import { enqueueKsefSubmitAfterDraft } from '@/lib/invoices/ksef-submit-enqueue';
import type { createClient } from '@/lib/supabase/server';
import { requireUserAndActiveOrg, type FormTenantCheck } from '@/lib/supabase/auth-context';
import { lookupCompanyByNip } from '@/lib/gus/client';
import { formatJobSendError } from '@/lib/jobs/error-message';
import {
  calculateInvoiceTotals,
  calculateLineItem,
  validateNipChecksum,
  ZW_WITHOUT_BASIS_MESSAGE,
} from '@/lib/xml/invoice-calculator';
import { buildInvoiceAnnotations } from '@/lib/invoices/annotations';
import { readTenantVatExemption } from '@/lib/invoices/vat-exemption';
import { readTenantCashMethodForIssuance } from '@/lib/invoices/cash-method';
import { issueDateNotTodayError } from '@/lib/invoices/issue-date';
import { addressCountryForKodUE, parseVatUe } from '@/lib/invoices/vat-ue';
import {
  advanceRecurringRunDate,
  findInvoiceForPeriod,
  isRecurringPeriodConflict,
  loadRecurringIssueLink,
  periodTakenMessage,
  RECURRING_CHANGED_MESSAGE,
  RECURRING_DRAFT_LEFT_NOTE,
  RECURRING_DRAFT_REFUSED_MESSAGE,
  withRecurringColumns,
  type RecurringIssueLink,
} from '@/lib/invoices/recurring/issue';
import { suggestNextInvoiceNumberForTenant } from '@/lib/invoices/next-number';
import { addDaysToIsoDate, dueDateFrom, todayInWarsaw } from '@/lib/format/warsaw-date';
import {
  EU_BUYER_COUNTRIES,
  invoiceFormSchema,
  type InvoiceFormValues,
} from '@/lib/schemas/invoice-form';
import type {
  Address,
  BuyerParty,
  Invoice,
  InvoiceLineItem,
  PaymentInfo,
  PaymentMethod,
  SellerParty,
} from '@/types/invoice';

// ═══════════════════════════════════════════════════════════════
// Helpery tenant / snapshot faktury
// ═══════════════════════════════════════════════════════════════

interface TenantAddressSnapshot {
  countryCode?: string;
  addressLine1?: string;
  addressLine2?: string;
}

interface TenantSnapshot {
  id: string;
  nip: string;
  name: string;
  address: TenantAddressSnapshot | null;
}

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

  const { data: raw, error } = await supabase
    .from('tenants')
    .select('id, nip, name, address_json')
    .eq('id', tenantId)
    .maybeSingle();

  if (error || !raw) throw new Error('Brak danych firmy');

  return {
    supabase,
    userId: user.id,
    tenant: {
      id: raw.id as string,
      nip: raw.nip as string,
      name: raw.name as string,
      address: (raw.address_json as TenantAddressSnapshot | null) ?? null,
    },
  };
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
// Budowanie pełnego obiektu Invoice z InvoiceFormValues
// ═══════════════════════════════════════════════════════════════

function buildInvoiceFromForm(
  values: InvoiceFormValues,
  tenant: TenantSnapshot,
  /** Podstawa zwolnienia z VAT (P_19A) — `null` = czynny podatnik VAT. */
  vatExemptionBasis: string | null,
  /** Metoda kasowa VAT firmy (P_16, #76). */
  cashMethod: boolean,
): Invoice {
  const lines: InvoiceLineItem[] = values.lines.map((line, idx) => {
    const calc = calculateLineItem({
      quantity: line.quantity,
      unitPriceNet: line.unitPriceNet,
      vatRate: line.vatRate,
    });
    return {
      ordinal: idx + 1,
      name: line.name,
      unit: line.unit,
      quantity: line.quantity,
      unitPriceNet: line.unitPriceNet,
      vatRate: line.vatRate,
      netAmount: calc.netAmount,
      vatAmount: calc.vatAmount,
      grossAmount: calc.grossAmount,
    };
  });

  const totals = calculateInvoiceTotals(lines);

  const sellerAddress: Address = {
    countryCode: tenant.address?.countryCode ?? 'PL',
    addressLine1: tenant.address?.addressLine1 ?? '',
    addressLine2: tenant.address?.addressLine2 ?? '',
  };

  const seller: SellerParty = {
    nip: tenant.nip,
    name: tenant.name,
    address: sellerAddress,
  };

  const buyerEmail =
    typeof values.buyerEmail === 'string' && values.buyerEmail.length > 0
      ? values.buyerEmail
      : undefined;

  const buyer: BuyerParty = (() => {
    const jst = 2 as const;
    const gv = 2 as const;
    const addr: Address = {
      countryCode: 'PL',
      addressLine1: values.buyerAddressLine1,
      addressLine2: values.buyerAddressLine2,
    };

    // AUD-70: firma z innego państwa UE — identyfikuje ją numer VAT-UE
    // (FA(3): KodUE + NrVatUE), nie NIP; adres ma kraj nabywcy, nie PL.
    if (values.buyerIsEu) {
      const vat = parseVatUe(values.buyerVatUe);
      // Schemat odrzuca taki numer wcześniej — to tylko zawężenie typu.
      if (!vat) throw new Error('Nieprawidłowy numer VAT-UE nabywcy');
      return {
        vatUeNumber: vat.normalized,
        name: values.buyerName,
        address: {
          countryCode: values.buyerCountryCode || addressCountryForKodUE(vat.kodUE),
          addressLine1: values.buyerAddressLine1,
          addressLine2: values.buyerAddressLine2,
        },
        jst,
        gv,
        email: buyerEmail,
      };
    }

    if (!values.buyerIsConsumer) {
      return {
        nip: values.buyerNip,
        name: values.buyerName,
        address: addr,
        jst,
        gv,
        email: buyerEmail,
      };
    }

    const t = values.buyerConsumerIdType;
    switch (t) {
      case 'pesel':
        return {
          name: values.buyerName,
          address: addr,
          pesel: values.buyerPesel.replace(/\D/g, ''),
          jst,
          gv,
          email: buyerEmail,
        };
      case 'no_id':
        return {
          name: values.buyerName,
          address: addr,
          noIdMarker: true,
          jst,
          gv,
          email: buyerEmail,
        };
      case 'id_card':
      case 'passport':
        return {
          name: values.buyerName,
          address: addr,
          nrInny: values.buyerIdDocument.trim(),
          jst,
          gv,
          email: buyerEmail,
        };
      default:
        return {
          name: values.buyerName,
          address: addr,
          noIdMarker: true,
          jst,
          gv,
          email: buyerEmail,
        };
    }
  })();

  const payment: PaymentInfo = {
    amountDue: totals.grossTotal,
    currency: 'PLN',
    dueDate: values.paymentDueDate,
    method: values.paymentMethod as PaymentMethod,
    bankAccount: values.bankAccount || undefined,
  };

  const saleTrim = values.saleDate?.trim();
  const saleDistinct =
    saleTrim &&
    saleTrim !== values.issueDate
      ? saleTrim
      : undefined;

  return {
    internalNumber: values.internalNumber,
    type: 'VAT',
    issueDate: values.issueDate,
    saleDate: saleDistinct,
    seller,
    buyer,
    lines,
    netTotal: totals.netTotal,
    vatTotal: totals.vatTotal,
    grossTotal: totals.grossTotal,
    payment,
    annotations: buildInvoiceAnnotations({
      lines,
      vatExemptionBasis,
      splitPayment: values.splitPayment === true,
      cashMethod,
    }),
    notes: values.notes && values.notes.length ? values.notes : undefined,
  };
}

/**
 * Kolumny nabywcy w `public.invoices` (ułatwia raportowanie bez parsowania JSON).
 *
 * Firma z UE (AUD-70) zapisuje się jak przy imporcie (`buyerIdentityFromParsed`):
 * B2B, typ `nip`, ale `buyer_nip` pusty — kolumna to VARCHAR(10) na polski
 * NIP, a numer VAT-UE leży w `buyer_data` / `fa3_data`.
 */
function buyerColumnsFromInvoiceForm(values: InvoiceFormValues): {
  is_b2c: boolean;
  buyer_id_type: 'nip' | 'pesel' | 'id_card' | 'passport' | 'no_id';
  buyer_nip: string | null;
  buyer_pesel: string | null;
  buyer_id_number: string | null;
} {
  if (values.buyerIsEu) {
    return {
      is_b2c: false,
      buyer_id_type: 'nip',
      buyer_nip: null,
      buyer_pesel: null,
      buyer_id_number: null,
    };
  }

  if (!values.buyerIsConsumer) {
    return {
      is_b2c: false,
      buyer_id_type: 'nip',
      buyer_nip: values.buyerNip,
      buyer_pesel: null,
      buyer_id_number: null,
    };
  }

  const t = values.buyerConsumerIdType ?? 'no_id';

  const pes =
    t === 'pesel' ? values.buyerPesel.replace(/\D/g, '') || null : null;
  const idNum =
    t === 'id_card' || t === 'passport'
      ? values.buyerIdDocument.trim() || null
      : null;

  return {
    is_b2c: true,
    buyer_id_type: t,
    buyer_nip: null,
    buyer_pesel: pes,
    buyer_id_number: idNum,
  };
}

// ═══════════════════════════════════════════════════════════════
// saveDraftAction / saveAndSendInvoiceAction
// ═══════════════════════════════════════════════════════════════

export type InvoiceActionResult =
  | { success: true; invoiceId: string; offline?: boolean }
  /** `invoiceId` — zapisany szkic (np. brak certyfikatu KSeF; user może do niego wrócić). */
  | { success: false; error: string; invoiceId?: string };

/** Wspólna ścieżka zapisu: INSERT invoices + line_items w transakcji
 *  "best-effort" (Supabase nie daje klienckich transakcji; w razie błędu
 *  linii usuwamy fakturę-matkę żeby nie zostawiać sierot).
 *
 *  `recurring` (plan Finora N1): faktura z pozycji cyklicznej. Powiązanie
 *  i okres idą w TYM SAMYM INSERT — unikalny indeks `uq_invoices_recurring_period`
 *  przepuszcza jedną fakturę na okres. Po udanym zapisie (z pozycjami)
 *  warunkowy UPDATE przesuwa `next_run_date`; jego błąd nie psuje zapisu.
 *  Oba zdarzenia — zajęcie okresu i samonaprawa daty po 23505 — idą do
 *  `audit_logs` (K3). Bez `recurring` wiersz i zachowanie są takie jak przed N1. */
async function insertInvoiceAndLines(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tenantId: string,
  invoice: Invoice,
  formValues?: InvoiceFormValues,
  recurringIssue?: { link: RecurringIssueLink; userId: string },
): Promise<InvoiceActionResult> {
  const recurring = recurringIssue?.link;
  const recurringUserId = recurringIssue?.userId ?? null;
  const b2c = formValues ? buyerColumnsFromInvoiceForm(formValues) : null;

  const { data: inserted, error: invErr } = await supabase
    .from('invoices')
    // N1: tylko faktura z pozycji cyklicznej niesie dwie nowe kolumny —
    // zwykła faktura ma wiersz bez zmian (bez tych kluczy, nie z NULL-ami).
    .insert(withRecurringColumns({
      tenant_id: tenantId,
      // DB CHECK: 'outgoing' | 'incoming' - NIE 'issued'.
      direction: 'outgoing',
      ksef_status: 'draft',
      internal_number: invoice.internalNumber,
      invoice_type: invoice.type,
      issue_date: invoice.issueDate,
      sale_date: invoice.saleDate ?? null,
      seller_nip: invoice.seller.nip,
      buyer_nip: b2c ? b2c.buyer_nip : invoice.buyer.nip ?? null,
      seller_data: invoice.seller,
      buyer_data: invoice.buyer,
      payment_data: invoice.payment,
      payment_due_date: invoice.payment.dueDate,
      currency: invoice.payment.currency,
      notes: invoice.notes ?? null,
      net_total: invoice.netTotal,
      vat_total: invoice.vatTotal,
      gross_total: invoice.grossTotal,
      is_b2c: b2c?.is_b2c ?? false,
      buyer_id_type: b2c?.buyer_id_type ?? 'nip',
      buyer_pesel: b2c?.buyer_pesel ?? null,
      buyer_id_number: b2c?.buyer_id_number ?? null,
      // fa3_data NOT NULL w 00001 - trzymamy tam ten sam snapshot co w
      // seller_data/buyer_data/payment_data, plus ewentualne adnotacje.
      // Generator XML i tak odtworzy go z `invoice` w jobie - to jest
      // jedynie źródło prawdy dla UI/raportów.
      fa3_data: invoice,
    }, recurring))
    .select('id')
    .single();

  if (invErr || !inserted) {
    // N1: za ten okres jest już faktura — komunikat z jej numerem i samonaprawa
    // `next_run_date` (gdy przesunięcie po tamtym zapisie się nie udało).
    // Sprawdzamy przy KAŻDYM 23505: przy podwójnym kliknięciu z tym samym
    // numerem Postgres zgłasza indeks numeru, choć zajęty jest i okres.
    if (recurring && invErr?.code === '23505') {
      const existing = await findInvoiceForPeriod(supabase, tenantId, recurring);
      if (existing) {
        const repaired = await advanceRecurringRunDate(supabase, tenantId, recurring);
        if (repaired) {
          await logAudit({
            action: 'recurring_invoice.run_date_repaired',
            tenantId,
            userId: recurringUserId,
            entityType: 'recurring_invoice',
            entityId: recurring.recurringInvoiceId,
            metadata: {
              recurringPeriod: recurring.period,
              existingInvoiceId: existing.id,
              existingInternalNumber: existing.internal_number,
              fromNextRunDate: recurring.runDate,
              toNextRunDate: recurring.nextRunDate,
            },
          });
        }
        return { success: false, error: periodTakenMessage(existing) };
      }
      if (isRecurringPeriodConflict(invErr)) {
        // Indeks okresu odrzucił zapis, ale faktury nie widać (np. usunięta
        // między zapisem a odczytem) — bez numeru, bez przesuwania daty.
        return {
          success: false,
          error: 'Faktura za ten okres jest już wystawiona. Sprawdź listę faktur.',
        };
      }
    }
    // Postgres 23505 = unique_violation. Po migracji 00028 to oznacza duplikat
    // `internal_number` w obrębie tego tenanta — najczęściej double-click "Wystaw
    // i wyślij" lub równoległa próba zapisu z innej karty. Friendly message
    // zamiast technicznego "duplicate key value violates unique constraint
    // \"uq_invoices_tenant_internal_number\"".
    if (invErr?.code === '23505') {
      return {
        success: false,
        error: `Faktura o numerze "${invoice.internalNumber}" już istnieje. Sprawdź listę faktur lub wybierz inny numer.`,
      };
    }
    return {
      success: false,
      error: invErr?.message ?? 'Nie udało się zapisać faktury',
    };
  }

  const { error: linesErr } = await supabase.from('invoice_line_items').insert(
    invoice.lines.map((line) => ({
      invoice_id: inserted.id,
      ordinal: line.ordinal,
      name: line.name,
      unit: line.unit,
      quantity: line.quantity,
      unit_price_net: line.unitPriceNet,
      net_amount: line.netAmount,
      vat_rate: line.vatRate,
      vat_amount: line.vatAmount,
      gross_amount: line.grossAmount,
    }))
  );

  if (linesErr) {
    // Rollback best-effort. Nawet jeśli się nie uda - faktura bez linii jest
    // w stanie 'draft' i user może ją edytować/usunąć ręcznie.
    await supabase.from('invoices').delete().eq('id', inserted.id);
    return {
      success: false,
      error: `Błąd zapisu pozycji: ${linesErr.message}`,
    };
  }

  if (recurring) {
    const advanced = await advanceRecurringRunDate(supabase, tenantId, recurring);
    await logAudit({
      action: 'recurring_invoice.issued',
      tenantId,
      userId: recurringUserId,
      entityType: 'recurring_invoice',
      entityId: recurring.recurringInvoiceId,
      metadata: {
        invoiceId: inserted.id as string,
        internalNumber: invoice.internalNumber,
        recurringPeriod: recurring.period,
        fromNextRunDate: recurring.runDate,
        toNextRunDate: recurring.nextRunDate,
        // false: przesunięcie nie wyszło (albo ktoś zmienił datę) — naprawi je następna próba po 23505.
        nextRunDateAdvanced: advanced,
      },
    });
  }

  return { success: true, invoiceId: inserted.id as string };
}

/**
 * N1: pozycja cykliczna z formularza (`?cykliczna=`) — odczyt PRZED zapisem;
 * zwykła faktura: `link` pusty. C3: okres z formularza (pokazany w banerze)
 * musi być okresem pozycji teraz — inaczej nic nie zapisujemy. Jeśli za
 * okres z formularza jest już faktura, klient dostaje jej numer (a nie radę
 * „wybierz inny numer”, która prowadziła do drugiej faktury za ten sam
 * miesiąc); jeśli nie — prośbę o ponowne otwarcie „Wystaw teraz”.
 */
async function recurringLinkForForm(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tenantId: string,
  values: InvoiceFormValues,
): Promise<{ ok: true; link: RecurringIssueLink | undefined } | { ok: false; error: string }> {
  if (!values.recurringInvoiceId) return { ok: true, link: undefined };
  const loaded = await loadRecurringIssueLink(supabase, tenantId, values.recurringInvoiceId);
  if (!loaded.ok) return loaded;
  const formPeriod = values.recurringPeriod;
  if (formPeriod && formPeriod !== loaded.link.period) {
    const existing = await findInvoiceForPeriod(supabase, tenantId, {
      recurringInvoiceId: loaded.link.recurringInvoiceId,
      period: formPeriod,
    });
    return { ok: false, error: existing ? periodTakenMessage(existing) : RECURRING_CHANGED_MESSAGE };
  }
  return { ok: true, link: loaded.link };
}

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
  const parsed = invoiceFormSchema.safeParse(values);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Nieprawidłowe dane faktury' };
  }
  try {
    const { supabase, tenant, userId } = await getTenantContext({ expectedTenantId });
    // Odpornie: przed wgraniem 00091 kolumny nie ma — zwykła faktura nie może
    // od niej zależeć.
    const vatExemptionBasis = await readTenantVatExemption(supabase, tenant.id);
    // Bez 00094 nie znamy prawnej adnotacji P_16; nie zapisujemy dokumentu.
    const cashMethod = await readTenantCashMethodForIssuance(supabase, tenant.id);
    const invoice = buildInvoiceFromForm(values, tenant, vatExemptionBasis, cashMethod);

    // Zwykły szkic — bez pozycji cyklicznej (odmowa wyżej).
    const result = await insertInvoiceAndLines(supabase, tenant.id, invoice, values);
    if (result.success && result.invoiceId) {
      await logAudit({
        action: 'invoice.draft_created',
        tenantId: tenant.id,
        userId,
        entityType: 'invoice',
        entityId: result.invoiceId,
        metadata: {
          internalNumber: invoice.internalNumber,
          grossTotal: invoice.grossTotal,
        },
      });
      revalidatePath('/invoices');
    }
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
  const parsed = invoiceFormSchema.safeParse(values);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Nieprawidłowe dane faktury' };
  }
  try {
    const { supabase, tenant, userId } = await getTenantContext({ expectedTenantId });
    // Faktura w KSeF jest wystawiona w dniu przesłania (F-092, A1) — ta sama
    // reguła dla wszystkich dokumentów. Inną datę można zapisać jako szkic.
    const notToday = issueDateNotTodayError(values.issueDate, 'form');
    if (notToday) return { success: false, error: notToday };
    // Odpornie: przed wgraniem 00091 kolumny nie ma — zwykła faktura nie może
    // od niej zależeć.
    const vatExemptionBasis = await readTenantVatExemption(supabase, tenant.id);
    // Bez 00094 nie znamy prawnej adnotacji P_16; nie zapisujemy dokumentu.
    const cashMethod = await readTenantCashMethodForIssuance(supabase, tenant.id);
    const invoice = buildInvoiceFromForm(values, tenant, vatExemptionBasis, cashMethod);
    // 0) „zw” bez podstawy zwolnienia: mówimy od razu, zanim faktura pójdzie do
    //    kolejki KSeF i wróci jako odrzucona. Szkic da się zapisać bez tego.
    if (invoice.lines.some((l) => l.vatRate === 'zw') && !invoice.annotations?.vatExemptionBasis) {
      return { success: false, error: ZW_WITHOUT_BASIS_MESSAGE };
    }
    // N1: pozycja wstrzymana, usunięta albo obca — odmowa przed zapisem.
    const recurring = await recurringLinkForForm(supabase, tenant.id, values);
    if (!recurring.ok) return { success: false, error: recurring.error };
    // 1) Najpierw draft - jeśli DB padnie, nie publikujemy eventu-sieroty.
    const saved = await insertInvoiceAndLines(
      supabase,
      tenant.id,
      invoice,
      values,
      recurring.link ? { link: recurring.link, userId } : undefined,
    );
    if (!saved.success) return saved;

    const enq = await enqueueKsefSubmitAfterDraft({
      supabase,
      tenantId: tenant.id,
      userId,
      invoiceId: saved.invoiceId,
      nip: tenant.nip,
      invoice,
      auditKind: 'regular',
      internalNumberForAudit: invoice.internalNumber,
    });

    if (!enq.ok) {
      if (saved.invoiceId) {
        const isSettingsRead = enq.error.startsWith('Nie można sprawdzić ustawień');
        const isNoCert =
          enq.error.includes('Najpierw wgraj certyfikat') ||
          enq.error.includes('Brak certyfikatu KSeF');
        if (isSettingsRead || isNoCert) {
          await logAudit({
            action: 'invoice.draft_created',
            tenantId: tenant.id,
            userId,
            entityType: 'invoice',
            entityId: saved.invoiceId,
            metadata: {
              internalNumber: invoice.internalNumber,
              note: isSettingsRead ? 'submit_aborted_tenant_read_error' : 'submit_blocked_no_ksef_cert',
              ...(recurring.link
                ? { recurringInvoiceId: recurring.link.recurringInvoiceId, recurringPeriod: recurring.link.period }
                : {}),
            },
          });
        }
      }
      return {
        success: false,
        // C4: szkic z okresem został — klient ma wiedzieć, że okres wróci po usunięciu szkicu.
        error: recurring.link && saved.invoiceId ? `${enq.error} ${RECURRING_DRAFT_LEFT_NOTE}` : enq.error,
        invoiceId: saved.invoiceId,
      };
    }

    if (!saved.invoiceId) {
      return { success: false, error: 'Brak invoiceId po zapisie szkicu' };
    }

    return {
      success: true,
      invoiceId: saved.invoiceId,
      offline: false,
    };
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
      paymentMethod: faktura.payment?.method ?? 'transfer',
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
