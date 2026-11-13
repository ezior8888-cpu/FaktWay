/**
 * Wiersze bazy (te same tabele i kolumny co strona) na model ekranów telefonu
 * (etap M7). Bez React Native i bez Supabase: testy w
 * `tests/unit/mobile-dane-mapowanie.test.ts`.
 *
 * Wzory ze strony:
 * - lista faktur: `app/(dashboard)/(faktury)/invoices/page.tsx` (wystawione,
 *   `direction = 'outgoing'`), szczegół `app/(dashboard)/invoices/[id]/page.tsx`;
 * - statusy: `components/invoices/status-badge.tsx`;
 * - skrzynka KSeF: `app/(dashboard)/(koszty)/inbox/` (`direction = 'incoming'`,
 *   sprzedawca z `seller_data`, potem `fa3_data.seller`, potem `seller_nip`;
 *   status „Nowa”/„Opisana” z `expenses.is_reviewed`).
 *
 * Kwoty w bazie są w złotych (numeric), na telefonie w groszach.
 */
import type { Faktura, FakturaKosztowa, MetodaPlatnosci, Pozycja, RodzajFaktury, StatusKsef, Strona } from '../../dane-przykladowe';

/** Kolumny pozycji, w jednej linii jak na stronie (`LINE_COLUMNS`). */
export const KOLUMNY_POZYCJI = 'ordinal, name, unit, quantity, unit_price_net, vat_rate, net_amount, vat_amount, gross_amount';

/** Lista faktur wystawionych razem z pozycjami: szczegół działa wtedy też bez internetu. */
export const KOLUMNY_FAKTURY = [
  'id, internal_number, invoice_kind, issue_date, sale_date, payment_due_date',
  'ksef_status, ksef_number, net_total, vat_total, gross_total, currency',
  'payment_status, paid_amount, buyer_nip, buyer_data, seller_data, payment_data, notes',
  'last_error, last_error_field, last_error_suggestion, created_at',
  `invoice_line_items(${KOLUMNY_POZYCJI})`,
].join(', ');

/** Skrzynka KSeF: kolumny strony (`INBOX_COLUMNS`) bez `fa3_data` w całości; sprzedawca z niej tylko awaryjnie. */
export const KOLUMNY_SKRZYNKI = `id, internal_number, ksef_number, issue_date, seller_nip, seller_data, seller_fa3:fa3_data->seller, gross_total, net_total, currency, ksef_accepted_at, origin, invoice_line_items(${KOLUMNY_POZYCJI})`;

/** Tyle najnowszych pokazujemy (jak skrzynka na stronie, `INBOX_LIMIT`); starsze na faktway.pl. */
export const LIMIT_LISTY = 200;

type Adres = { addressLine1?: string | null; addressLine2?: string | null } | null | undefined;
type StronaZBazy = { name?: string | null; nip?: string | null; address?: Adres; email?: string | null } | null | undefined;

export type WierszPozycji = {
  ordinal?: number | null;
  name?: string | null;
  unit?: string | null;
  quantity?: number | string | null;
  unit_price_net?: number | string | null;
  vat_rate?: string | null;
  net_amount?: number | string | null;
  vat_amount?: number | string | null;
  gross_amount?: number | string | null;
};

export type WierszFaktury = {
  id: string;
  internal_number?: string | null;
  invoice_kind?: string | null;
  issue_date?: string | null;
  sale_date?: string | null;
  payment_due_date?: string | null;
  ksef_status?: string | null;
  ksef_number?: string | null;
  net_total?: number | string | null;
  vat_total?: number | string | null;
  gross_total?: number | string | null;
  currency?: string | null;
  payment_status?: string | null;
  paid_amount?: number | string | null;
  buyer_nip?: string | null;
  buyer_data?: unknown;
  seller_data?: unknown;
  payment_data?: unknown;
  notes?: string | null;
  last_error?: string | null;
  last_error_field?: string | null;
  last_error_suggestion?: string | null;
  created_at?: string | null;
  invoice_line_items?: WierszPozycji[] | null;
};

export type WierszSkrzynki = {
  id: string;
  internal_number?: string | null;
  ksef_number?: string | null;
  issue_date?: string | null;
  seller_nip?: string | null;
  seller_data?: unknown;
  /** `fa3_data->seller` (alias w zapytaniu). */
  seller_fa3?: unknown;
  gross_total?: number | string | null;
  net_total?: number | string | null;
  currency?: string | null;
  ksef_accepted_at?: string | null;
  origin?: string | null;
  invoice_line_items?: WierszPozycji[] | null;
};

/** Wydatek powiązany z fakturą ze skrzynki (`expenses.ksef_invoice_id`). */
export type PowiazanyWydatek = { id: string; ksef_invoice_id: string | null; is_reviewed: boolean };

/** Złote z bazy (liczba albo tekst numeric) na grosze; brak albo śmieci to 0. */
export function grosze(wartosc: unknown): number {
  if (wartosc === null || wartosc === undefined || wartosc === '') return 0;
  const n = typeof wartosc === 'number' ? wartosc : Number(wartosc);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function liczba(wartosc: unknown): number {
  const n = typeof wartosc === 'number' ? wartosc : Number(wartosc);
  return Number.isFinite(n) ? n : 0;
}

function tekst(wartosc: unknown): string {
  return typeof wartosc === 'string' ? wartosc.trim() : '';
}

const DZIEN = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Dzień w Warszawie (RRRR-MM-DD): „dziś” dla terminów i daty przyjęcia w KSeF, jak `todayInWarsaw` na stronie. */
export function dzienWarszawa(chwila: Date | string = new Date()): string {
  const d = typeof chwila === 'string' ? new Date(chwila) : chwila;
  return Number.isNaN(d.getTime()) ? '' : DZIEN.format(d);
}

/** `invoices.ksef_status` na stan telefonu (etykiety jak `status-badge.tsx`). */
export function statusZBazy(status: string | null | undefined): StatusKsef {
  switch (status) {
    case 'accepted':
      return 'przyjeta';
    case 'rejected':
      return 'odrzucona';
    case 'failed':
      return 'blad';
    case 'pending':
    case 'queued':
    case 'sending':
    case 'offline_queued':
      return 'wysylanie';
    default:
      // `draft` i każdy nowy, nieznany telefonowi stan: bez obietnicy, że coś trwa.
      return 'robocza';
  }
}

const RODZAJE: Record<string, RodzajFaktury> = { regular: 'vat', advance: 'zaliczkowa', correction: 'korygujaca', final: 'rozliczajaca' };

const METODY: Record<string, MetodaPlatnosci> = { transfer: 'Przelew', cash: 'Gotówka', card: 'Karta', mobile: 'Płatność mobilna', other: 'Inna' };

function adres(a: Adres): string | undefined {
  const linie = [tekst(a?.addressLine1), tekst(a?.addressLine2)].filter(Boolean);
  return linie.length > 0 ? linie.join(', ') : undefined;
}

/** `vat_rate` z bazy: „23”, „8”, „5”, „0”, „zw”, „np”, „oo” (i warianty „0 KR”, „0 WDT”, „0 EX”). */
export function stawkaZBazy(stawka: string | null | undefined): Pick<Pozycja, 'stawkaVat' | 'stawkaOpis'> {
  const t = tekst(stawka);
  if (/^\d+(\.\d+)?$/.test(t)) return { stawkaVat: Number(t) };
  return { stawkaVat: 0, stawkaOpis: t || 'brak' };
}

export function pozycjeZBazy(wiersze: WierszPozycji[] | null | undefined): Pozycja[] {
  return [...(wiersze ?? [])]
    .sort((a, b) => liczba(a.ordinal) - liczba(b.ordinal))
    .map((w) => ({
      nazwa: tekst(w.name) || '(bez nazwy)',
      ilosc: liczba(w.quantity),
      jednostka: tekst(w.unit),
      cenaNetto: grosze(w.unit_price_net),
      ...stawkaZBazy(w.vat_rate),
      netto: grosze(w.net_amount),
      vat: grosze(w.vat_amount),
      brutto: grosze(w.gross_amount),
    }));
}

/** Faktura wystawiona z bazy na model ekranów (lista i szczegół). */
export function fakturaZBazy(w: WierszFaktury): Faktura {
  const nabywca = (w.buyer_data ?? null) as StronaZBazy;
  const sprzedawca = (w.seller_data ?? null) as StronaZBazy;
  const platnosc = (w.payment_data ?? null) as { method?: string | null; dueDate?: string | null; bankAccount?: string | null; bankName?: string | null } | null;
  const statusKsef = statusZBazy(w.ksef_status);
  const wystawiona = tekst(w.issue_date) || dzienWarszawa(w.created_at ?? new Date());
  const zaplacona = w.payment_status === 'paid';
  const zaplacono = grosze(w.paid_amount);
  const waluta = tekst(w.currency).toUpperCase() || 'PLN';
  const strona: Strona | undefined = sprzedawca && tekst(sprzedawca.name)
    ? { nazwa: tekst(sprzedawca.name), nip: tekst(sprzedawca.nip) || undefined, adres: adres(sprzedawca.address) }
    : undefined;
  const komunikat = tekst(w.last_error);
  return {
    id: w.id,
    numer: tekst(w.internal_number) || 'Bez numeru',
    kontrahent: tekst(nabywca?.name) || '(bez nazwy nabywcy)',
    nipKontrahenta: tekst(w.buyer_nip) || tekst(nabywca?.nip),
    dataWystawienia: wystawiona,
    terminPlatnosci: tekst(w.payment_due_date) || tekst(platnosc?.dueDate) || wystawiona,
    brutto: grosze(w.gross_total),
    netto: grosze(w.net_total),
    statusKsef,
    numerKsef: tekst(w.ksef_number) || undefined,
    zaplacona,
    pozycje: pozycjeZBazy(w.invoice_line_items),
    rodzaj: RODZAJE[tekst(w.invoice_kind)] ?? 'vat',
    metodaPlatnosci: METODY[tekst(platnosc?.method)] ?? 'Przelew',
    rachunek: tekst(platnosc?.bankAccount) || undefined,
    bank: tekst(platnosc?.bankName) || undefined,
    uwagi: tekst(w.notes) || undefined,
    blad:
      (statusKsef === 'odrzucona' || statusKsef === 'blad') && komunikat
        ? { komunikat, pole: tekst(w.last_error_field), podpowiedz: tekst(w.last_error_suggestion) }
        : undefined,
    waluta,
    sprzedawca: strona,
    adresKontrahenta: adres(nabywca?.address),
    ...(tekst(nabywca?.address?.addressLine1) || tekst(nabywca?.address?.addressLine2)
      ? { adresKontrahentaLinie: { linia1: tekst(nabywca?.address?.addressLine1), linia2: tekst(nabywca?.address?.addressLine2) } }
      : {}),
    emailKontrahenta: tekst(nabywca?.email) || undefined,
    dataSprzedazy: tekst(w.sale_date) || undefined,
    zaplacono: !zaplacona && zaplacono > 0 ? zaplacono : undefined,
  };
}

/** Sprzedawca jak na stronie (`sellerDisplay`): `seller_data`, potem `fa3_data.seller`, potem `seller_nip`. */
export function sprzedawcaSkrzynki(w: Pick<WierszSkrzynki, 'seller_data' | 'seller_fa3' | 'seller_nip'>): { nazwa: string; nip: string } {
  const sd = (w.seller_data ?? null) as StronaZBazy;
  const fa3 = (w.seller_fa3 ?? null) as StronaZBazy;
  return {
    nazwa: tekst(sd?.name) || tekst(fa3?.name) || '(bez nazwy sprzedawcy)',
    nip: tekst(sd?.nip) || tekst(fa3?.nip) || tekst(w.seller_nip),
  };
}

/**
 * Skrzynka KSeF z bazy. Status z wydatku (jedna faktura, jeden koszt);
 * `wydatki === null` (odczyt się nie udał) daje wiersze bez statusu, jak
 * kolumna „—” na stronie. Faktura z historii KSeF (`origin = 'ksef_import'`)
 * to archiwum bez kosztu.
 */
export function skrzynkaZBazy(wiersze: WierszSkrzynki[], wydatki: PowiazanyWydatek[] | null): FakturaKosztowa[] {
  const poFakturze = new Map<string, PowiazanyWydatek>();
  for (const w of wydatki ?? []) {
    if (w.ksef_invoice_id && !poFakturze.has(w.ksef_invoice_id)) poFakturze.set(w.ksef_invoice_id, w);
  }
  return wiersze.map((w) => {
    const s = sprzedawcaSkrzynki(w);
    const wydatek = poFakturze.get(w.id);
    return {
      id: w.id,
      numer: tekst(w.internal_number) || 'Bez numeru',
      numerKsef: tekst(w.ksef_number) || undefined,
      sprzedawca: s.nazwa,
      nipSprzedawcy: s.nip,
      dataWystawienia: tekst(w.issue_date) || dzienWarszawa(w.ksef_accepted_at ?? new Date()),
      otrzymano: w.ksef_accepted_at ? dzienWarszawa(w.ksef_accepted_at) : undefined,
      brutto: grosze(w.gross_total),
      netto: w.net_total === null || w.net_total === undefined ? undefined : grosze(w.net_total),
      waluta: tekst(w.currency).toUpperCase() || 'PLN',
      status: wydatki === null || !wydatek ? undefined : wydatek.is_reviewed ? 'opisana' : 'nowa',
      zHistorii: w.origin === 'ksef_import',
      wydatekId: wydatek?.id,
      pozycje: pozycjeZBazy(w.invoice_line_items),
    };
  });
}
