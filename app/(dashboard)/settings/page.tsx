import Link from 'next/link';
import type { SupabaseClient } from '@supabase/supabase-js';
import { RiAddLine } from '@remixicon/react';

import { BusinessStartForm } from '@/components/settings/business-start-form';
import { CalendarFeedCard } from '@/components/settings/calendar-feed-card';
import { CashMethodForm } from '@/components/settings/cash-method-form';
import { CompanyBankAccountForm } from '@/components/settings/company-bank-account-form';
import { CompanyProfileForm } from '@/components/settings/company-profile-form';
import { DocumentArchiveForm } from '@/components/settings/document-archive-form';
import { InvoiceNumberingForm } from '@/components/settings/invoice-numbering-form';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { VatExemptionForm } from '@/components/settings/vat-exemption-form';
import { buttonVariants } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { KOTWICA_RACHUNKU_FIRMY, readTenantBankAccount } from '@/lib/expenses/rachunek-firmy';
import { readTenantBusinessStart } from '@/lib/invoices/business-start';
import { readTenantCashMethod } from '@/lib/invoices/cash-method';
import { readTenantVatExemption } from '@/lib/invoices/vat-exemption';
import { readArchiveOrders } from '@/lib/archiwum/zlecenia';
import { readInvoiceSeries } from '@/lib/numeracja/baza';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { getPageContext } from '@/lib/supabase/page-context';

export const dynamic = 'force-dynamic';

/**
 * Zakładka „Firma” = General z Finory (plan P14): profil firmy, zwolnienie
 * z VAT, metoda kasowa, data rozpoczęcia działalności (#data-rozpoczecia —
 * link z Pulpitu), rachunek firmy (#rachunek-firmy, link z listy „Do zapłaty”;
 * krok 3.4, część 2: nowa sekcja na końcu, decyzja D1), numeracja faktur
 * (#numeracja, krok 2.5: serie numerów, też nowa sekcja na końcu). Z General wylatują język, waluta, strefa czasowa i rok
 * obrotowy (zawsze PL / PLN / Europe/Warsaw / rok kalendarzowy), a Profile
 * Finory nie ma odpowiednika. Usunięcie firmy jest tylko w „Konto i dane”.
 */
export default async function SettingsPage() {
  const { supabase, tenantId, role } = await getPageContext();

  const today = todayInWarsaw();
  const [{ data: tenant }, vatExemptionBasis, vatCashMethod, businessStartedOn, archiveOrders, calendarFeedActive, bankAccount, invoiceSeries] = await Promise.all([
    supabase
      .from('tenants')
      .select('name, nip, address_json')
      .eq('id', tenantId)
      .maybeSingle(),
    // Osobno i odpornie — przed migracją 00091 kolumny nie ma.
    readTenantVatExemption(supabase, tenantId),
    // Odpornie — przed migracją 00094 kolumny nie ma.
    readTenantCashMethod(supabase, tenantId),
    // Odpornie — przed migracją 00153 kolumny nie ma.
    readTenantBusinessStart(supabase, tenantId),
    // Archiwum dokumentów (krok 6.4, 00178): zlecenia widzi tylko owner/admin (RLS); błąd to pusta lista.
    role === 'owner' || role === 'admin' ? readArchiveOrders(supabase, tenantId) : Promise.resolve([]),
    // Odpornie — przed migracją 00182 tabeli nie ma; wtedy karty adresu nie pokazujemy.
    readCalendarFeedActive(supabase, tenantId),
    // Odpornie: przed migracją 00183 kolumny nie ma (brak rachunku).
    readTenantBankAccount(supabase, tenantId),
    // Serie numeracji (00199, krok 2.5); `null`, gdy odczyt się nie udał.
    readInvoiceSeries(supabase as unknown as SupabaseClient, today),
  ]);

  // Edycja danych firmy (F-008): właściciel i administrator, jak ustawienia VAT.
  const canEditCompany = role === 'owner' || role === 'admin';
  const addressJson = (
    tenant?.address_json && typeof tenant.address_json === 'object' ? tenant.address_json : null
  ) as { addressLine1?: string; addressLine2?: string } | null;
  const companyAddress = {
    name: tenant?.name ?? '',
    addressLine1: addressJson?.addressLine1 ?? '',
    addressLine2: addressJson?.addressLine2 ?? '',
  };

  return (
    <FieldGroup>
      <div className="flex justify-between gap-2 max-sm:flex-col sm:items-center">
        <div>
          <FieldLabel>Dane firmy</FieldLabel>
          <FieldDescription>
            {canEditCompany
              ? 'Nazwa i adres siedziby na kolejnych fakturach'
              : 'Informacje o aktywnej organizacji (z onboardingu / GUS)'}
          </FieldDescription>
        </div>
        <Link href="/onboarding?action=new" prefetch={false} className={buttonVariants({ variant: 'outline' })}>
          <RiAddLine aria-hidden />
          Dodaj kolejną organizację
        </Link>
      </div>

      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel>NIP</FieldLabel>
        </FieldContent>
        <span className="font-mono text-sm">{tenant?.nip || '-'}</span>
      </Field>

      {canEditCompany ? (
        <CompanyProfileForm initial={companyAddress} />
      ) : (
        <>
          <Field orientation="responsive">
            <FieldContent>
              <FieldLabel>Nazwa firmy</FieldLabel>
            </FieldContent>
            <span className="text-sm font-medium">{tenant?.name ?? 'Bez nazwy'}</span>
          </Field>
          {addressJson ? (
            <Field orientation="responsive">
              <FieldContent>
                <FieldLabel>Adres siedziby</FieldLabel>
              </FieldContent>
              <span className="text-sm leading-relaxed">
                {addressJson.addressLine1}
                <br />
                {addressJson.addressLine2}
              </span>
            </Field>
          ) : null}
        </>
      )}

      <Separator />

      <div>
        <FieldLabel>Podatek VAT</FieldLabel>
        <FieldDescription>
          {vatExemptionBasis
            ? `Zwolniona z VAT — ${vatExemptionBasis}`
            : vatCashMethod
              ? 'Czynny podatnik VAT — metoda kasowa'
              : 'Czynny podatnik VAT'}
        </FieldDescription>
      </div>

      <VatExemptionForm initialBasis={vatExemptionBasis} canEdit={canEditCompany} />

      <Separator />

      <CashMethodForm initialEnabled={vatCashMethod} canEdit={canEditCompany} />

      <Separator />

      <div id="data-rozpoczecia" className="scroll-mt-24">
        <BusinessStartForm initialStartedOn={businessStartedOn} canEdit={canEditCompany} today={todayInWarsaw()} />
      </div>

      <Separator />

      {/* Link z e-maila o gotowej paczce: /settings#archiwum. */}
      <div id="archiwum" className="flex scroll-mt-24 flex-col gap-5">
        <DocumentArchiveForm canRequest={canEditCompany} orders={archiveOrders} today={todayInWarsaw()} />
      </div>

      {canEditCompany && calendarFeedActive !== null ? (
        <>
          <Separator />
          <CalendarFeedCard initialActive={calendarFeedActive} />
        </>
      ) : null}
      <div id={KOTWICA_RACHUNKU_FIRMY} className="scroll-mt-24">
        <CompanyBankAccountForm initialAccount={bankAccount} canEdit={canEditCompany} />
      </div>

      <Separator />

      <div id="numeracja" className="scroll-mt-24">
        <InvoiceNumberingForm initialSeries={invoiceSeries} canEdit={canEditCompany} today={today} />
      </div>
    </FieldGroup>
  );
}

/** Czy firma ma adres kalendarza; `null`, gdy tabeli jeszcze nie ma albo odczyt się nie udał. */
async function readCalendarFeedActive(
  supabase: Awaited<ReturnType<typeof getPageContext>>['supabase'],
  tenantId: string,
): Promise<boolean | null> {
  const { data, error } = await (supabase as unknown as SupabaseClient)
    .from('calendar_feed_tokens')
    .select('tenant_id')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  return error ? null : data !== null;
}
