import { buyerNameOf, clientIdentity, CONSUMERS_NAME } from '@/lib/dashboard/rankings';
import { shortCompanyName } from '@/lib/format/company-name';
import { roundToCents } from '@/lib/xml/invoice-calculator';

import { topWithOther, type BreakdownSlice } from './breakdown';
import type { SaleInvoice } from './sales';

/**
 * Klienci na `/analizy/sprzedaz` (plan Finora P11): Najlepszy klient, Udział
 * klientów w przychodach, Klienci: rośnie / spada. Klucz klienta jak
 * w „Najwięksi klienci” na Pulpicie (`clientIdentity`): `buyer_nip`, bez
 * niego nazwa z `buyer_data`, nabywcy B2C (`is_b2c`) jako jedna pozycja
 * „Konsumenci”. Kwoty netto z `getSalesInvoices` (korekta jako różnica,
 * ROZ bez zaliczek).
 */

export const OTHER_CLIENTS_LABEL = 'Pozostali';
/** Próg podpisu „Uwaga: jeden klient to ponad połowa przychodu”. */
export const CONCENTRATION_PCT = 50;

export interface ClientTotal {
  key: string;
  name: string;
  nip: string | null;
  consumers: boolean;
  net: number;
}

/** Nazwa nabywcy na liście faktur: z faktury (forma prawna skrócona), potem NIP. */
export function saleBuyerName(inv: Pick<SaleInvoice, 'buyer_nip' | 'buyer_data' | 'is_b2c'>): string {
  const name = buyerNameOf(inv.buyer_data);
  if (name !== null) return shortCompanyName(name);
  if (inv.is_b2c === true) return CONSUMERS_NAME;
  const nip = (inv.buyer_nip ?? '').replace(/\D/g, '');
  return nip !== '' ? `NIP ${nip}` : 'Nabywca bez nazwy';
}

interface Group {
  key: string;
  nip: string | null;
  consumers: boolean;
  newest: { date: string; id: string; name: string } | null;
}

/** Grupy klientów z nazwą z najnowszej faktury, która ją ma (jak `rankClients`). */
function groupClients(invoices: readonly SaleInvoice[]): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const inv of invoices) {
    const identity = clientIdentity(inv);
    if (identity === null) continue;
    let group = groups.get(identity.key);
    if (!group) {
      group = { ...identity, newest: null };
      groups.set(identity.key, group);
    }
    const name = buyerNameOf(inv.buyer_data);
    if (name === null) continue;
    const newer = group.newest === null
      || inv.issueDate > group.newest.date
      || (inv.issueDate === group.newest.date && inv.id > group.newest.id);
    if (newer) group.newest = { date: inv.issueDate, id: inv.id, name };
  }
  return groups;
}

function groupName(group: Group): string {
  if (group.consumers) return CONSUMERS_NAME;
  return shortCompanyName(group.newest?.name ?? (group.nip ? `NIP ${group.nip}` : ''));
}

/** Klucz klienta faktury (`null` = faktura bez NIP-u i nazwy, odpada). */
export function clientKeyOf(inv: SaleInvoice): string | null {
  return clientIdentity(inv)?.key ?? null;
}

/** Nazwy klientów po kluczu — z najnowszej faktury w `invoices`. */
export function clientNames(invoices: readonly SaleInvoice[]): Map<string, string> {
  return new Map([...groupClients(invoices)].map(([key, group]) => [key, groupName(group)]));
}

/** Netto per klient, tylko klienci z netto > 0, malejąco (remis: po kluczu). */
export function clientTotals(invoices: readonly SaleInvoice[]): ClientTotal[] {
  const groups = groupClients(invoices);
  const net = new Map<string, number>();
  for (const inv of invoices) {
    const key = clientKeyOf(inv);
    if (key !== null) net.set(key, (net.get(key) ?? 0) + inv.net);
  }
  return [...groups.values()]
    .map((g) => ({
      key: g.key,
      name: groupName(g),
      nip: g.nip,
      consumers: g.consumers,
      net: roundToCents(net.get(g.key) ?? 0) || 0,
    }))
    .filter((c) => c.net > 0)
    .sort((a, b) => b.net - a.net || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export interface ClientShares {
  slices: BreakdownSlice[];
  /** Jeden klient ma ponad 50% przychodu z dodatnich pozycji. */
  concentrated: boolean;
}

/** „Udział klientów w przychodach”: top `limit` + „Pozostali” (Asset Allocation). */
export function clientShares(invoices: readonly SaleInvoice[], limit = 5): ClientShares {
  const slices = topWithOther(
    clientTotals(invoices).map((c) => ({ key: c.key, label: c.name, amount: c.net })),
    limit,
    OTHER_CLIENTS_LABEL,
  );
  return {
    slices,
    concentrated: slices.some((s) => !s.other && s.percentage > CONCENTRATION_PCT),
  };
}

export interface ClientMover {
  key: string;
  name: string;
  /** NIP albo „Konsumenci” — podpis pod nazwą (Finora: symbol spółki). */
  subtitle: string;
  /** Zmiana w %, jedna cyfra po przecinku. */
  percent: number;
  net: number;
  prevNet: number;
}

/**
 * „Klienci: rośnie / spada” (Top Gainers / Top Losers): netto okna
 * `[currentFrom, toExclusive)` vs `[prevFrom, currentFrom)`. Liczymy tylko
 * klientów z dodatnim netto w poprzednim oknie — bez podstawy procent nie
 * istnieje. Klient, który przestał kupować, to −100% i trafia do „spada”
 * (dlatego nie `rankClients`, który bierze tylko klientów z bieżącą sprzedażą).
 */
export function clientMovers(
  invoices: readonly SaleInvoice[],
  window: { prevFrom: string; currentFrom: string; toExclusive: string },
  limit = 6,
): { gainers: ClientMover[]; losers: ClientMover[] } {
  const inWindow = invoices.filter((inv) => inv.issueDate >= window.prevFrom && inv.issueDate < window.toExclusive);
  const groups = groupClients(inWindow);
  const totals = new Map<string, { net: number; prevNet: number }>();
  for (const inv of inWindow) {
    const key = clientKeyOf(inv);
    if (key === null) continue;
    const t = totals.get(key) ?? { net: 0, prevNet: 0 };
    if (inv.issueDate >= window.currentFrom) t.net += inv.net;
    else t.prevNet += inv.net;
    totals.set(key, t);
  }
  const movers: ClientMover[] = [];
  for (const [key, t] of totals) {
    const prevNet = roundToCents(t.prevNet) || 0;
    const net = roundToCents(t.net) || 0;
    if (prevNet <= 0) continue;
    const group = groups.get(key)!;
    movers.push({
      key,
      name: groupName(group),
      subtitle: group.consumers ? 'Nabywcy bez NIP' : group.nip ? `NIP ${group.nip}` : 'Bez NIP',
      percent: Math.round(((net - prevNet) / prevNet) * 1000) / 10,
      net,
      prevNet,
    });
  }
  const byKey = (a: ClientMover, b: ClientMover) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return {
    gainers: movers.filter((m) => m.percent > 0).sort((a, b) => b.percent - a.percent || byKey(a, b)).slice(0, limit),
    losers: movers.filter((m) => m.percent < 0).sort((a, b) => a.percent - b.percent || byKey(a, b)).slice(0, limit),
  };
}
