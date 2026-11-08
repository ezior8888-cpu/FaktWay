import { EU_BUYER_COUNTRIES, type InvoiceFormValues } from '@/lib/schemas/invoice-form';
import { BUYER_ID_TYPE_LABELS } from '@/types/invoice-types';

/** Stałe formularza zwykłej faktury (`../invoice-form.tsx`) i jego części. */

export const defaultLine: InvoiceFormValues['lines'][number] = {
  name: '',
  unit: 'szt',
  quantity: 1,
  unitPriceNet: 0,
  vatRate: '23',
};

/** Etykieta pola w stylu Finory (`FieldLabel`): mały tekst nad polem. */
export const labelClass = 'mb-2';

/**
 * Od tej szerokości pozycje idą wierszami siatki (Finora:
 * `invoice-line-items.tsx`), poniżej kartami. Do P5 próg był `lg`, ale od
 * `lg` obok dokumentu stoi kolumna akcji 18rem i wiersz z siedmioma polami
 * nie mieścił się w karcie. Przegląd P5 policzył też `xl` (1280 px): przy
 * rozwiniętym pasku bocznym na treść karty zostaje ok. 585 px, a wiersz
 * `LINE_GRID` z odstępami ma ok. 619 px — przewijał się w bok. Przy 1360 px
 * (laptopy 1366) zostaje ok. 660 px.
 */
export const LINES_LAYOUT_MEDIA = '(min-width: 1360px)';

/** Kolumny wiersza pozycji: Nazwa · J.m. · Ilość · Cena netto · VAT · Brutto · usuń. */
export const LINE_GRID =
  'grid grid-cols-[minmax(8rem,1fr)_3.5rem_4.5rem_6rem_5.5rem_6.5rem_2rem] gap-2';

/**
 * Rodzaj nabywcy (AUD-70). W schemacie to dwie flagi — `buyerIsConsumer`
 * i `buyerIsEu` — bo starsze wywołania znają tylko pierwszą; w interfejsie
 * jeden wybór z trzech, żeby nie dało się zaznaczyć obu naraz.
 *
 * `buyer-is-consumer` to id dawnego pola wyboru „osoba fizyczna” — zostaje
 * na opcji „Osoba prywatna”, bo klika w nie test e2e 07.
 */
export type BuyerKind = 'pl' | 'consumer' | 'eu';

export const BUYER_KINDS: ReadonlyArray<{ kind: BuyerKind; id: string; label: string; hint: string }> = [
  { kind: 'pl', id: 'buyer-kind-pl', label: 'Firma z Polski (NIP)', hint: 'Dane z GUS po numerze NIP' },
  { kind: 'consumer', id: 'buyer-is-consumer', label: 'Osoba prywatna', hint: 'PESEL, dowód, paszport lub bez identyfikatora' },
  { kind: 'eu', id: 'buyer-kind-eu', label: 'Firma z UE (VAT-UE)', hint: 'Numer VAT-UE z prefiksem kraju' },
];

export const errorTextClass = 'mt-1.5 flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400';

// E1: jedno źródło etykiet dla `items` i <SelectItem> (Base UI pokazuje surową wartość bez `items`)
export const PAYMENT_METHOD_ITEMS = [
  { value: 'transfer', label: 'Przelew' },
  { value: 'cash', label: 'Gotówka' },
  { value: 'card', label: 'Karta' },
  { value: 'other', label: 'Inna' },
] as const

export const EU_COUNTRY_ITEMS = EU_BUYER_COUNTRIES.map((k) => ({ value: k.code, label: k.name }))

export const BUYER_ID_TYPE_ITEMS = (['pesel', 'id_card', 'passport', 'no_id'] as const).map((k) => ({
  value: k,
  label: BUYER_ID_TYPE_LABELS[k],
}))

/** Pod przyciskiem wysyłki w trybie „Wystaw teraz” z faktury cyklicznej (C2). */
export const RECURRING_NO_DRAFT_TEXT = 'Fakturę cykliczną wystawiasz od razu — szkic nie zamyka okresu.';

export function euCountryName(code: string): string | undefined {
  return EU_BUYER_COUNTRIES.find((k) => k.code === code)?.name;
}

/** Pole stawki VAT — ten sam zestaw opcji co przed P5, w obu układach pozycji. */
export const vatSelectClass =
  'border-input bg-background dark:bg-input/30 h-8 w-full min-w-0 rounded-none border px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 aria-invalid:border-destructive [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:text-[16px]';
