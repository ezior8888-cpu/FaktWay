/**
 * Data kalendarzowa faktury na ekranie (PLAN-FINORA §7.1): RRRR-MM-DD z bazy →
 * DD.MM.RRRR. Bez strefy czasowej — to dzień z dokumentu, nie chwila.
 * Brak daty = „—”; napis, który nie jest datą, zostaje bez zmian (nie
 * zgadujemy). Moduł bez importów: działa na serwerze i w przeglądarce.
 */
export function formatInvoiceDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}
