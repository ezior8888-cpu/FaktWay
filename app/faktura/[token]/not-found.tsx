import { BuyerNotice } from './_components/buyer-notice';

/** Link nieznany, wygasły albo cofnięty: jeden komunikat, bez rozróżniania powodu. */
export default function BuyerInvoiceNotFound() {
  return (
    <BuyerNotice
      title="Ten link nie działa"
      text="Link mógł wygasnąć albo sprzedawca go cofnął. Poproś sprzedawcę o nowy link albo o fakturę e-mailem."
    />
  );
}
