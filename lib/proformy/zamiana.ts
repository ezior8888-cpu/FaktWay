import { getQuote, listQuoteInvoices } from '@/lib/proformy/baza';
import { QUOTE_VAT_RATE_LABELS, type QuoteInvoiceLink, type SalesQuote } from '@/lib/proformy/model';
import {
  CONVERSION_ADVANCE_REFUSED_TITLE,
  CONVERSION_TEXTS,
  conversionAdvanceMixedRatesText,
  conversionAdvanceText,
  conversionAdvanceTitle,
  conversionAdvanceUnsupportedRateText,
  conversionDraftText,
  conversionDraftTitle,
  conversionQuoteLinkLabel,
  conversionRegularText,
  conversionRegularTitle,
  conversionTakenText,
  conversionTakenTitle,
  invoiceNumbersSentence,
  quoteGenitiveName,
} from '@/lib/proformy/teksty';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';

/**
 * Zamiana proformy albo oferty w fakturę albo fakturę zaliczkową (krok 2.4).
 * Zamiana tylko WYPEŁNIA formularz faktury danymi z dokumentu: nic nie
 * zapisuje, nie wystawia i nie wysyła do KSeF. Strona formularza podaje
 * powiązanie (dokument i numer kolejnej zamiany) w ukrytych polach, a zapis
 * faktury wpisuje je w tym samym INSERT (`lib/proformy/powiazanie.ts`).
 *
 * Druga faktura z tego samego dokumentu tylko po potwierdzeniu: gdy
 * z dokumentu jest już faktura, formularz bez parametru `kolejna=1` (który
 * dokłada okno potwierdzenia na ekranie dokumentu) zostaje pusty, z komunikatem
 * i linkiem do dokumentu. Numer i daty faktury są zawsze nowe, uwag
 * dokumentu nie przenosimy (dotyczą oferty, nie faktury).
 */

export interface ConversionNotice {
  tone: 'info' | 'error';
  title: string;
  text: string;
  /** Wyjście z komunikatu (protokół, pkt 4). */
  link?: { href: string; label: string };
}

export interface QuoteSource {
  quote: SalesQuote;
  /** Faktury już utworzone z dokumentu, po numerze zamiany. */
  invoices: QuoteInvoiceLink[];
  /** Numer kolejnej zamiany do ukrytego pola formularza. */
  seq: number;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const QUOTES_LIST_LINK = { href: '/proformy', label: CONVERSION_TEXTS.listLink };

function quoteLink(quote: SalesQuote): ConversionNotice['link'] {
  return { href: `/proformy/${quote.id}`, label: conversionQuoteLinkLabel(quote.kind, quote.number) };
}

/**
 * Dokument do zamiany z bazy (klient z sesji, RLS 00198 i filtr firmy).
 * `confirmed`: klient potwierdził kolejną fakturę z dokumentu, który już ją ma.
 */
export async function loadQuoteSource(
  client: unknown,
  tenantId: string,
  rawId: string | null,
  confirmed: boolean,
): Promise<{ ok: true; source: QuoteSource } | { ok: false; notice: ConversionNotice }> {
  const notFound: ConversionNotice = {
    tone: 'error',
    title: CONVERSION_TEXTS.notFoundTitle,
    text: CONVERSION_TEXTS.notFoundText,
    link: QUOTES_LIST_LINK,
  };
  if (!rawId || !UUID_SHAPE.test(rawId)) return { ok: false, notice: notFound };

  let quote: SalesQuote | null;
  let invoices: QuoteInvoiceLink[] = [];
  try {
    quote = await getQuote(client, tenantId, rawId);
    if (quote) invoices = await listQuoteInvoices(client, tenantId, rawId);
  } catch (error) {
    console.error('[proformy] zamiana, odczyt dokumentu:', error);
    return {
      ok: false,
      notice: { tone: 'error', title: CONVERSION_TEXTS.readFailedTitle, text: CONVERSION_TEXTS.readFailedText, link: QUOTES_LIST_LINK },
    };
  }
  if (!quote) return { ok: false, notice: notFound };
  if (quote.status !== 'issued' || !quote.number) {
    return {
      ok: false,
      notice: { tone: 'error', title: conversionDraftTitle(quote.kind), text: conversionDraftText(quote.kind), link: quoteLink(quote) },
    };
  }
  if (invoices.length > 0 && !confirmed) {
    return {
      ok: false,
      notice: {
        tone: 'error',
        title: conversionTakenTitle(quote.kind, quote.number),
        text: conversionTakenText(invoiceNumbersSentence(invoices)),
        link: quoteLink(quote),
      },
    };
  }
  const seq = invoices.reduce((max, invoice) => Math.max(max, invoice.seq), 0) + 1;
  return { ok: true, source: { quote, invoices, seq } };
}

function previousInvoices(source: QuoteSource): string | null {
  return source.invoices.length > 0 ? invoiceNumbersSentence(source.invoices) : null;
}

/** Zwykła faktura: nabywca z NIP (kontrahent z bazy firmy), pozycje i sposób zapłaty. */
export function regularInvoiceFromQuote(source: QuoteSource): {
  initialValues: Partial<InvoiceFormValues>;
  notice: ConversionNotice;
} {
  const { quote } = source;
  const party = quote.counterparty;
  return {
    initialValues: {
      buyerIsConsumer: false,
      buyerIsEu: false,
      buyerVatUe: '',
      buyerCountryCode: '',
      buyerNip: party.nip,
      buyerName: party.name,
      buyerAddressLine1: party.addressLine1,
      buyerAddressLine2: party.addressLine2,
      buyerEmail: party.email ?? '',
      lines: quote.items.map((item) => ({
        name: item.name,
        unit: item.unit,
        quantity: item.quantity,
        unitPriceNet: item.unitPriceNet,
        vatRate: item.vatRate,
      })),
      // Oferta nie ma płatności: przelew jak w pustym formularzu faktury.
      paymentMethod: quote.paymentMethod ?? 'transfer',
      bankAccount: quote.bankAccount ?? '',
    },
    notice: {
      tone: 'info',
      title: conversionRegularTitle(quote.kind, quote.number),
      text: conversionRegularText(previousInvoices(source)),
    },
  };
}

/** Pola formularza faktury zaliczkowej, które wypełnia dokument. */
export interface AdvancePrefillValues {
  buyer: {
    type: 'b2b';
    idType: 'nip';
    nip: string;
    name: string;
    address: { addressLine1: string; addressLine2: string; countryCode: string };
  };
  paymentMethod: 'transfer' | 'cash' | 'card' | 'other';
  bankAccount: string;
  totalContractAmount: number;
  advanceAmount: number;
  vatRate: '23' | '8' | '5' | '0';
  description: string;
}

/** Stawki, które ma formularz faktury zaliczkowej (`advanceInvoiceSchema`). */
const ADVANCE_RATES = ['23', '8', '5', '0'] as const;

function isAdvanceRate(rate: string): rate is AdvancePrefillValues['vatRate'] {
  return (ADVANCE_RATES as readonly string[]).includes(rate);
}

/** Rachunek do pola faktury zaliczkowej (26 cyfr NRB); rachunek spoza Polski zostaje do wpisania ręcznie. */
function nrbDigits(bankAccount: string | null): string {
  const clean = (bankAccount ?? '').replace(/\s/g, '').toUpperCase();
  const digits = clean.startsWith('PL') ? clean.slice(2) : clean;
  return /^\d{26}$/.test(digits) ? digits : '';
}

/**
 * Faktura zaliczkowa: wartość umowy i zaliczka z kwoty brutto dokumentu,
 * jedna stawka. Formularz zaliczki w FaktWay ma jedną stawkę 23, 8, 5 albo 0,
 * więc dokument z kilkoma stawkami albo ze stawką zw, oo, np nie wypełnia go
 * (odmowa z wyjściem: zwykła faktura z dokumentu albo zaliczka wpisana ręcznie),
 * zamiast podsuwać stawkę, której na dokumencie nie ma.
 */
export function advanceInvoiceFromQuote(
  source: QuoteSource,
): { ok: true; initialValues: AdvancePrefillValues; notice: ConversionNotice } | { ok: false; notice: ConversionNotice } {
  const { quote } = source;
  const rates = [...new Set(quote.items.map((item) => item.vatRate))];
  const unsupported = rates.filter((rate) => !isAdvanceRate(rate));
  if (unsupported.length > 0) {
    return {
      ok: false,
      notice: {
        tone: 'error',
        title: CONVERSION_ADVANCE_REFUSED_TITLE,
        text: conversionAdvanceUnsupportedRateText(unsupported.join(', ')),
        link: quoteLink(quote),
      },
    };
  }
  const [rate] = rates;
  if (rates.length !== 1 || !rate || !isAdvanceRate(rate)) {
    return {
      ok: false,
      notice: {
        tone: 'error',
        title: CONVERSION_ADVANCE_REFUSED_TITLE,
        text: conversionAdvanceMixedRatesText(rates.map((r) => QUOTE_VAT_RATE_LABELS[r]).join(', ')),
        link: quoteLink(quote),
      },
    };
  }
  const party = quote.counterparty;
  return {
    ok: true,
    initialValues: {
      buyer: {
        type: 'b2b',
        idType: 'nip',
        nip: party.nip,
        name: party.name,
        address: { addressLine1: party.addressLine1, addressLine2: party.addressLine2, countryCode: party.countryCode || 'PL' },
      },
      paymentMethod: quote.paymentMethod ?? 'transfer',
      bankAccount: nrbDigits(quote.bankAccount),
      totalContractAmount: quote.grossTotal,
      advanceAmount: quote.grossTotal,
      vatRate: rate,
      description: `Zamówienie według ${quoteGenitiveName(quote.kind, quote.number)}`,
    },
    notice: {
      tone: 'info',
      title: conversionAdvanceTitle(quote.kind, quote.number),
      text: conversionAdvanceText(previousInvoices(source)),
    },
  };
}
