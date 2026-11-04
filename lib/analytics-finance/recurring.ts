import type { CostEntry } from '@/lib/dashboard/costs';
import { clientIdentity } from '@/lib/dashboard/rankings';
import { shortCompanyName } from '@/lib/format/company-name';
import { canSetAsRecurring } from '@/lib/invoices/recurring/visibility';
import { roundToCents } from '@/lib/xml/invoice-calculator';

import { clientNames } from './clients';
import type { SaleInvoice } from './sales';

/**
 * N3 — stałe koszty i stali klienci (plan Finora §8 N3; zasila P10 „Stałe
 * koszty”, P11 „Stali klienci”, a później P8 „Stałe koszty”).
 *
 * Kontrahent jest „stały”, gdy ma kwotę > 0 w co najmniej `MIN_MONTHS`
 * z `RECURRING_MONTHS` ostatnich miesięcy (z bieżącym). Średnia kwota =
 * średnia miesięcznych sum z miesięcy, w których się pojawił; „typowy dzień”
 * = mediana dnia miesiąca jego dokumentów (dolna przy parzystej liczbie).
 */

export const RECURRING_MONTHS = 4;
export const MIN_MONTHS = 3;

export interface RecurringEntry {
  key: string;
  name: string;
  /** RRRR-MM-DD */
  date: string;
  amount: number;
  /**
   * N1: faktura, którą można wskazać jako wzór faktury cyklicznej (opcjonalne).
   * Z najnowszej takiej faktury kontrahenta powstaje `RecurringItem.templateInvoiceId`.
   */
  templateInvoiceId?: string | null;
}

export interface RecurringItem {
  key: string;
  name: string;
  /** Średnia miesięczna kwota z miesięcy, w których kontrahent wystąpił. */
  averageAmount: number;
  /** Typowy dzień miesiąca (1–31). */
  typicalDay: number;
  /** W ilu z `monthKeys` wystąpił (z kwotą > 0). */
  months: number;
  /**
   * N1: id najnowszej faktury kontrahenta spełniającej warunki wzoru (tylko
   * „Stali klienci”; ustawione wyłącznie, gdy taka faktura jest w oknie).
   * Z niej „Zrób fakturę cykliczną” otwiera arkusz faktury cyklicznej.
   */
  templateInvoiceId?: string;
}

export function findRecurring(
  entries: readonly RecurringEntry[],
  monthKeys: readonly string[],
  minMonths = MIN_MONTHS,
  limit = 5,
): RecurringItem[] {
  const window = new Set(monthKeys);
  const groups = new Map<string, {
    byMonth: Map<string, number>;
    days: number[];
    newest: { date: string; name: string };
    template: { date: string; id: string } | null;
  }>();
  for (const entry of entries) {
    const month = entry.date.slice(0, 7);
    if (!window.has(month)) continue;
    let group = groups.get(entry.key);
    if (!group) {
      group = { byMonth: new Map(), days: [], newest: { date: entry.date, name: entry.name }, template: null };
      groups.set(entry.key, group);
    }
    group.byMonth.set(month, (group.byMonth.get(month) ?? 0) + entry.amount);
    group.days.push(Number(entry.date.slice(8, 10)));
    if (entry.date >= group.newest.date) group.newest = { date: entry.date, name: entry.name };
    if (entry.templateInvoiceId && (group.template === null || entry.date >= group.template.date)) {
      group.template = { date: entry.date, id: entry.templateInvoiceId };
    }
  }

  const items: RecurringItem[] = [];
  for (const [key, group] of groups) {
    const active = [...group.byMonth.values()].map((v) => roundToCents(v)).filter((v) => v > 0);
    if (active.length < minMonths) continue;
    const days = group.days.slice().sort((a, b) => a - b);
    items.push({
      key,
      name: group.newest.name,
      averageAmount: roundToCents(active.reduce((s, v) => s + v, 0) / active.length),
      typicalDay: days[Math.floor((days.length - 1) / 2)]!,
      months: active.length,
      // Klucz tylko, gdy jest wzór — wyniki bez niego zostają takie jak przed N1.
      ...(group.template ? { templateInvoiceId: group.template.id } : {}),
    });
  }
  return items
    .sort((a, b) => b.averageAmount - a.averageAmount || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, limit);
}

/**
 * Stałe koszty: dostawca po `seller_nip` (same cyfry), a bez NIP-u (paragon)
 * po nazwie sprzedawcy — jak klucz klienta. Kwota = wypływ brutto, jak
 * „Subscriptions” w Finorze (ile płacisz).
 */
export function recurringSuppliers(
  costs: readonly CostEntry[],
  monthKeys: readonly string[],
  limit = 5,
): RecurringItem[] {
  const entries: RecurringEntry[] = [];
  for (const cost of costs) {
    const nip = (cost.sellerNip ?? '').replace(/\D/g, '');
    const name = cost.sellerName?.trim() ?? '';
    const key = nip !== '' ? `nip:${nip}` : name !== '' ? `name:${name.toLowerCase()}` : null;
    if (key === null) continue;
    entries.push({ key, name: shortCompanyName(name || `NIP ${nip}`), date: cost.issueDate, amount: cost.outflow });
  }
  return findRecurring(entries, monthKeys, MIN_MONTHS, limit);
}

/** Stali klienci: klucz klienta z `clientIdentity`, kwota = netto (§2.4). */
export function recurringClients(
  invoices: readonly SaleInvoice[],
  monthKeys: readonly string[],
  limit = 5,
): RecurringItem[] {
  const names = clientNames(invoices);
  const entries: RecurringEntry[] = [];
  for (const inv of invoices) {
    const identity = clientIdentity(inv);
    if (identity === null) continue;
    const key = identity.key;
    entries.push({
      key,
      name: names.get(key) ?? '',
      date: inv.issueDate,
      amount: inv.net,
      // N1: `getSalesInvoices` zwraca tylko przyjęte faktury sprzedaży w PLN, więc o wzorze
      // rozstrzygają rodzaj, typ i pochodzenie — te same warunki co akcja tworzenia.
      // „Konsumenci” to wielu różnych nabywców pod jednym kluczem: faktura jednego z nich
      // nie jest wzorem dla „klienta”, więc przy tej pozycji przycisku nie ma.
      templateInvoiceId: !identity.consumers && canSetAsRecurring({
        direction: 'outgoing',
        origin: inv.origin,
        invoice_kind: inv.kind,
        invoice_type: inv.invoiceType,
        ksef_status: 'accepted',
        currency: 'PLN',
      })
        ? inv.id
        : null,
    });
  }
  // Nazwa z `clientNames` (najnowsza faktura z nazwą), nie z ostatniego wpisu.
  return findRecurring(entries, monthKeys, MIN_MONTHS, limit).map((item) => ({
    ...item,
    name: names.get(item.key) ?? item.name,
  }));
}
