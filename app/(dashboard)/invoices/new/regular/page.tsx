import Link from 'next/link';

import {
  prefillFromInvoiceAction,
  prefillFromLastInvoiceAction,
  type PrefillFromInvoice,
} from '@/components/invoices/actions';
import { InvoiceForm } from '@/components/invoices/invoice-form';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { loadTenantSellerForForms } from '@/lib/invoices/load-tenant-seller';
import { getRecurringInvoice } from '@/lib/invoices/recurring/queries';
import { recurringPeriodKey, recurringPeriodLabel } from '@/lib/invoices/recurring/schedule';
import { readTenantVatExemption } from '@/lib/invoices/vat-exemption';
import { loadInvoiceNumbering } from '@/lib/numeracja/baza';
import { selectedNumberingOption } from '@/lib/numeracja/model';
import { loadQuoteSource, regularInvoiceFromQuote } from '@/lib/proformy/zamiana';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';
import { getPageContext, type PageContext } from '@/lib/supabase/page-context';

type SearchParams = Record<string, string | string[] | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function param(params: SearchParams, key: string): string | null {
  const v = params[key];
  const value = Array.isArray(v) ? v[0] : v;
  return value?.trim() ? value.trim() : null;
}

interface Notice {
  tone: 'info' | 'error';
  title: string;
  text: string;
  /** Link pod tekstem — wyjście z komunikatu (protokół pkt 4). */
  link?: { href: string; label: string };
}

/** Podkład ze wskazanej faktury albo pozycji cyklicznej (plan Finora N1) albo z proformy (krok 2.4). */
interface Source {
  /** Z proformy bez numeru i dat (zostają domyślne formularza), stąd `Partial`. */
  initialValues: PrefillFromInvoice['values'] | Partial<InvoiceFormValues>;
  recurringInvoiceId: string | null;
  /**
   * Okres, który pokazał baner (`recurringPeriodKey(next_run_date)` w chwili
   * renderu). Formularz odsyła go w ukrytym polu, a zapis odmawia, gdy
   * pozycja ma już inny okres — nieaktualna karta nie wystawi faktury za
   * następny miesiąc pod etykietą tego, który klient widział (C3).
   */
  recurringPeriod: string | null;
  /**
   * Krok 2.4: proforma albo oferta (`?proforma=`) i numer kolejnej zamiany
   * do ukrytych pól; zapis wpisuje powiązanie w tym samym INSERT co fakturę.
   */
  salesQuoteId?: string;
  salesQuoteSeq?: string;
}

/**
 * `?cykliczna=<id>` — „Wystaw teraz” z faktury cyklicznej: pozycja tej firmy,
 * aktywna; formularz z podkładem faktury-wzoru i ukrytym polem pozycji
 * (zapis zajmie okres — `insertInvoiceAndLines`).
 * `?wzor=<id>` — „Duplikuj”: sam podkład, bez pozycji cyklicznej.
 *
 * `?proforma=<id>` — „Wystaw fakturę” z proformy albo oferty (krok 2.4):
 * dane dokumentu i ukryte powiązanie; gdy z dokumentu jest już faktura, tylko
 * z `&kolejna=1` (potwierdzenie na ekranie dokumentu), inaczej pusty formularz.
 *
 * Nieznane, obce albo wstrzymane id: pusty formularz z komunikatem, nie 500.
 * Żaden z tych parametrów niczego nie zapisuje — fakturę wystawia człowiek.
 */
async function loadSource(
  ctx: PageContext,
  params: SearchParams,
): Promise<{ source: Source | null; notice: Notice | null }> {
  const cyklicznaId = param(params, 'cykliczna');
  if (cyklicznaId) {
    const pozycja = UUID.test(cyklicznaId)
      ? await getRecurringInvoice(ctx.supabase, ctx.tenantId, cyklicznaId)
      : null;
    if (!pozycja) {
      return {
        source: null,
        notice: {
          tone: 'error',
          title: 'Nie znaleziono faktury cyklicznej',
          text: 'Mogła zostać usunięta albo należy do innej firmy. Formularz jest pusty — możesz wystawić zwykłą fakturę.',
        },
      };
    }
    if (!pozycja.active) {
      return {
        source: null,
        notice: {
          tone: 'error',
          title: `Faktura cykliczna „${pozycja.name}” jest wstrzymana`,
          text: 'Wznów ją na liście faktur cyklicznych albo wystaw zwykłą fakturę.',
        },
      };
    }
    const prefill = await prefillFromInvoiceAction(pozycja.template_invoice_id).catch(() => null);
    if (!prefill) {
      return {
        source: null,
        notice: {
          tone: 'error',
          title: `Nie udało się wczytać faktury-wzoru dla „${pozycja.name}”`,
          // Arkusz „Edytuj” nie zmienia wzoru — wyjście to nowa pozycja z innego wzoru.
          text: 'Formularz jest pusty. Spróbuj ponownie za chwilę. Jeśli to się powtarza, usuń tę fakturę cykliczną i utwórz ją z innej faktury-wzoru.',
          link: { href: '/invoices/recurring', label: 'Przejdź do faktur cyklicznych' },
        },
      };
    }
    const okresKlucz = recurringPeriodKey(pozycja.next_run_date, pozycja.frequency);
    const okres = recurringPeriodLabel(okresKlucz);
    return {
      source: { initialValues: prefill.values, recurringInvoiceId: pozycja.id, recurringPeriod: okresKlucz },
      notice: {
        tone: 'info',
        title: `Faktura cykliczna „${pozycja.name}” — ${okres}`,
        text: `Wypełniliśmy formularz na podstawie faktury ${prefill.sourceNumber ?? 'wzoru'} z nowym numerem i dzisiejszą datą. Sprawdź dane i wystaw fakturę.`,
      },
    };
  }

  const proformaId = param(params, 'proforma');
  if (proformaId) {
    const loaded = await loadQuoteSource(ctx.supabase, ctx.tenantId, proformaId, param(params, 'kolejna') === '1');
    if (!loaded.ok) return { source: null, notice: loaded.notice };
    const { initialValues, notice } = regularInvoiceFromQuote(loaded.source);
    return {
      source: {
        initialValues,
        recurringInvoiceId: null,
        recurringPeriod: null,
        salesQuoteId: loaded.source.quote.id,
        salesQuoteSeq: String(loaded.source.seq),
      },
      notice,
    };
  }

  const wzorId = param(params, 'wzor');
  if (wzorId) {
    const prefill = UUID.test(wzorId) ? await prefillFromInvoiceAction(wzorId).catch(() => null) : null;
    if (!prefill) {
      return {
        source: null,
        notice: {
          tone: 'error',
          title: 'Nie znaleziono faktury do skopiowania',
          text: 'Mogła zostać usunięta albo należy do innej firmy. Formularz jest pusty.',
        },
      };
    }
    return {
      source: { initialValues: prefill.values, recurringInvoiceId: null, recurringPeriod: null },
      notice: {
        tone: 'info',
        title: `Kopia faktury ${prefill.sourceNumber ?? ''}`.trim(),
        text: 'Nabywca, pozycje i sposób zapłaty jak w kopiowanej fakturze; numer i daty są nowe. Sprawdź dane przed wystawieniem.',
      },
    };
  }

  return { source: null, notice: null };
}

/**
 * Podkład z ostatniej faktury pobieramy TUTAJ, na serwerze, i podajemy
 * formularzowi propem. Wariant z `useEffect` w komponencie klienckim dawałby
 * to samo o jedno okrążenie sieci później — a baner podpowiedzi pojawiałby się
 * z opóźnieniem i przesuwał formularz pod palcem, który już celuje w pole.
 *
 * Tak samo zwolnienie z VAT: firma zwolniona dostaje „zw” jako domyślną
 * stawkę nowej pozycji od pierwszego renderu.
 *
 * I numer: podpowiedź kolejnego po ostatniej fakturze (F-015), żeby seria
 * nie zależała od pamięci użytkownika. Krok 2.5: serie numeracji firmy
 * z serią domyślną zwykłej faktury i kolejnym numerem z jej licznika; firma
 * bez serii dostaje tę samą podpowiedź co dotąd.
 *
 * Sprzedawca (P5) idzie wyłącznie do nagłówka dokumentu w układzie Finory.
 * Akcja zapisu i tak czyta go sama z profilu firmy; błąd odczytu tutaj nie
 * blokuje formularza (nagłówek pokaże wtedy link do danych firmy).
 *
 * Plan Finora N1: `?cykliczna=` i `?wzor=` (opis przy `loadSource`). Z takim
 * podkładem baner „Wypełnij z ostatniej faktury” się nie pokazuje.
 */
export default async function NewRegularInvoicePage({
  searchParams,
}: { searchParams?: Promise<SearchParams> }) {
  const ctx = await getPageContext();
  const { supabase, tenantId } = ctx;
  const params = (await searchParams) ?? {};
  const [podpowiedz, vatExemptionBasis, numbering, loadedSeller, { source, notice }] = await Promise.all([
    prefillFromLastInvoiceAction(),
    readTenantVatExemption(supabase, tenantId),
    loadInvoiceNumbering(supabase, tenantId, 'regular', todayInWarsaw()),
    loadTenantSellerForForms().catch(() => null),
    loadSource(ctx, params),
  ]);
  const seller = loadedSeller?.seller ?? null;
  const suggestedNumber = selectedNumberingOption(numbering)?.preview ?? null;

  // UX-01: `tenantId` — firma tej strony; zapis odsyła ją i odmawia, gdy
  // w innej karcie przełączono firmę (nie wystawi faktury za inną firmę).
  // `key`: przełączenie firmy w TEJ karcie odświeża stronę — formularz montuje
  // się od nowa, zamiast nieść dane wpisane dla poprzedniej firmy.
  const form = (
    <InvoiceForm
      key={tenantId}
      tenantId={tenantId}
      prefill={source ? null : podpowiedz}
      vatExempt={vatExemptionBasis !== null}
      suggestedNumber={suggestedNumber}
      numbering={numbering}
      seller={seller}
      {...(source
        ? {
            initialValues: source.initialValues,
            recurringInvoiceId: source.recurringInvoiceId,
            ...(source.recurringPeriod ? { recurringPeriod: source.recurringPeriod } : {}),
            ...(source.salesQuoteId && source.salesQuoteSeq
              ? { salesQuoteId: source.salesQuoteId, salesQuoteSeq: source.salesQuoteSeq }
              : {}),
          }
        : {})}
    />
  );

  if (!notice) return form;

  return (
    <div className="space-y-4">
      <Alert variant={notice.tone === 'error' ? 'destructive' : 'default'}>
        <AlertTitle>{notice.title}</AlertTitle>
        <AlertDescription>
          <p>{notice.text}</p>
          {notice.link ? (
            <Link href={notice.link.href} className="font-medium">
              {notice.link.label}
            </Link>
          ) : null}
        </AlertDescription>
      </Alert>
      {form}
    </div>
  );
}
