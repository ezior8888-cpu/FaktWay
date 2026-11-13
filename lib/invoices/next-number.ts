/**
 * Podpowiedź kolejnego numeru faktury (F-015 w raporcie audytu bloku 1).
 *
 * Numer faktury wpisywało się ręcznie przy każdej fakturze, więc ciągłość
 * serii (art. 106e ust. 1 pkt 2 ustawy o VAT) zależała wyłącznie od pamięci
 * użytkownika. Tu z numeru ostatniej faktury wyprowadzamy kolejny:
 *  - licznik + 1 z zachowaniem zer wiodących („007” → „008”),
 *  - gdy numer zawiera rok (i miesiąc) ostatniej faktury, a dzisiejsza data
 *    jest w innym okresie — nowy rok / miesiąc i licznik od 1,
 *  - numeracja ciągła (bez okresu w numerze) po prostu rośnie.
 * To tylko podpowiedź: pole numeru pozostaje edytowalne, a unikalność
 * pilnuje baza.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

interface Group {
  start: number;
  text: string;
  value: number;
}

function numericGroups(s: string): Group[] {
  return [...s.matchAll(/\d+/g)].map((m) => ({ start: m.index ?? 0, text: m[0], value: Number(m[0]) }));
}

function pad(value: number, like: string): string {
  return like.length > 1 && like.startsWith('0') ? String(value).padStart(like.length, '0') : String(value);
}

export function suggestNextInvoiceNumber(
  last: { number: string; issueDate: string } | null,
  todayIso: string,
): string | null {
  if (!last?.number?.trim()) return null;
  const groups = numericGroups(last.number);
  if (groups.length === 0) return null;

  const lastYear = Number(last.issueDate.slice(0, 4));
  const lastMonth = Number(last.issueDate.slice(5, 7));
  const newYear = Number(todayIso.slice(0, 4));
  const newMonth = Number(todayIso.slice(5, 7));

  const yearIdx = groups.findIndex((g) => g.text.length === 4 && g.value === lastYear);
  // Miesiąc: 1–2 cyfry równe miesiącowi ostatniej faktury, najbliżej roku.
  const monthCandidates = groups
    .map((g, i) => ({ g, i }))
    .filter(({ g, i }) => i !== yearIdx && g.text.length <= 2 && g.value === lastMonth);
  const monthIdx =
    yearIdx === -1
      ? -1
      : (monthCandidates.sort((a, b) => Math.abs(a.i - yearIdx) - Math.abs(b.i - yearIdx))[0]?.i ?? -1);

  // Licznik: pozostała grupa — przy numerze „okres na początku” ostatnia,
  // przy „licznik na początku” pierwsza.
  const counterCandidates = groups.map((_, i) => i).filter((i) => i !== yearIdx && i !== monthIdx);
  if (counterCandidates.length === 0) return null;
  const periodFirst = yearIdx !== -1 && yearIdx < counterCandidates[0]!;
  const counterIdx = periodFirst ? counterCandidates[counterCandidates.length - 1]! : counterCandidates[0]!;

  const periodChanged =
    yearIdx !== -1 && (newYear !== lastYear || (monthIdx !== -1 && newMonth !== lastMonth));

  const replacement = new Map<number, string>();
  if (periodChanged) {
    replacement.set(yearIdx, String(newYear));
    if (monthIdx !== -1) {
      const monthText = groups[monthIdx]!.text;
      replacement.set(monthIdx, monthText.length === 2 ? String(newMonth).padStart(2, '0') : String(newMonth));
    }
    replacement.set(counterIdx, pad(1, groups[counterIdx]!.text));
  } else {
    const c = groups[counterIdx]!;
    replacement.set(counterIdx, pad(c.value + 1, c.text));
  }

  let out = '';
  let pos = 0;
  groups.forEach((g, i) => {
    out += last.number.slice(pos, g.start) + (replacement.get(i) ?? g.text);
    pos = g.start + g.text.length;
  });
  return out + last.number.slice(pos);
}

/** Ile kolejnych zajętych numerów przeskakujemy, zanim zrezygnujemy z podpowiedzi. */
const MAX_TAKEN_SKIPS = 5;

/**
 * Kolejne numery, które sprawdza podpowiedź (`suggestNextInvoiceNumberForTenant`):
 * pierwszy po ostatniej fakturze, potem po każdym zajętym, najwyżej
 * `MAX_TAKEN_SKIPS`. Pierwszy wolny z listy to podpowiedź. Publiczne API
 * (krok 7.1) pyta bazę o zajęte numery jednym zapytaniem, bez odczytu faktur.
 */
export function nextInvoiceNumberCandidates(
  last: { number: string; issueDate: string },
  todayIso: string,
): string[] {
  const candidates: string[] = [];
  let candidate = suggestNextInvoiceNumber(last, todayIso);
  for (let i = 0; candidate && i < MAX_TAKEN_SKIPS; i++) {
    candidates.push(candidate);
    candidate = suggestNextInvoiceNumber({ number: candidate, issueDate: todayIso }, todayIso);
  }
  return candidates;
}

/** Rodzaj dokumentu (`invoices.invoice_kind`), dla którego liczymy podpowiedź. */
export type SuggestionKind = 'regular' | 'advance' | 'final' | 'correction';

/**
 * Seria „jak dotąd” (krok 2.5, 00199): liczą się tylko faktury bez serii
 * (sprzed serii, z KSeF) i wystawione w tej serii, więc numery innej serii jej
 * nie przestawiają. `null`: firma bez serii, liczą się wszystkie (jak dotąd).
 */
export interface LegacySeriesScope {
  seriesId: string;
}

/** Ostatnia faktura sprzedażowa firmy danego rodzaju (opcjonalnie tylko wystawiona w FaktWay). */
async function lastOutgoing(
  supabase: SupabaseClient,
  tenantId: string,
  kind: SuggestionKind,
  onlyApp: boolean,
  scope: LegacySeriesScope | null,
): Promise<{ internal_number: string | null; issue_date: string | null } | null> {
  let query = supabase
    .from('invoices')
    .select('internal_number, issue_date')
    .eq('tenant_id', tenantId)
    .eq('direction', 'outgoing')
    .eq('invoice_kind', kind);
  if (onlyApp) query = query.eq('origin', 'app');
  if (scope) query = query.or(`number_series_id.is.null,number_series_id.eq.${scope.seriesId}`);
  const { data } = await query
    .not('internal_number', 'is', null)
    .order('issue_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { internal_number: string | null; issue_date: string | null } | null) ?? null;
}

/**
 * Podpowiedź dla firmy: kolejny numer po ostatniej fakturze sprzedażowej
 * (zwykłej — korekty i zaliczki zwykle mają własne serie). „Ostatnia” to
 * najpóźniejsza data wystawienia, a przy tej samej dacie — najpóźniej
 * utworzona. Numer już zajęty (np. szkic z ręcznie wpisanym numerem)
 * przeskakujemy; gdy wciąż zajęty — brak podpowiedzi zamiast złej.
 *
 * Decyzja Bartosza 22.10.2026: najpierw faktury wystawione w FaktWay
 * (`origin = app`) — sprzedaż spoza FaktWay przychodzi z KSeF na bieżąco
 * i nie może przestawiać serii. Dopiero gdy firma nie ma żadnej, bierzemy
 * dowolne pochodzenie (przeprowadzka tylko przez historię z KSeF albo plik).
 */
export async function suggestNextInvoiceNumberForTenant(
  supabase: SupabaseClient,
  tenantId: string,
  todayIso: string,
): Promise<string | null> {
  return suggestNextInvoiceNumberForKind(supabase, tenantId, 'regular', todayIso, null);
}

/**
 * Ta sama podpowiedź dla każdego rodzaju dokumentu (krok 2.5): kolejny numer
 * po ostatnim dokumencie tego rodzaju (zaliczki, korekty i rozliczenia zwykle
 * mają własne serie), w serii „jak dotąd” tylko z jej faktur i faktur bez
 * serii. Zajęty numer (dowolna faktura firmy) przeskakujemy jak wyżej.
 */
export async function suggestNextInvoiceNumberForKind(
  supabase: SupabaseClient,
  tenantId: string,
  kind: SuggestionKind,
  todayIso: string,
  scope: LegacySeriesScope | null,
): Promise<string | null> {
  const last = (await lastOutgoing(supabase, tenantId, kind, true, scope))
    ?? (await lastOutgoing(supabase, tenantId, kind, false, scope));
  if (!last?.internal_number || !last.issue_date) return null;

  let candidate = suggestNextInvoiceNumber(
    { number: String(last.internal_number), issueDate: String(last.issue_date) },
    todayIso,
  );
  for (let i = 0; candidate && i < MAX_TAKEN_SKIPS; i++) {
    const { count, error } = await supabase
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('internal_number', candidate);
    if (error) return null;
    if (!count) return candidate;
    candidate = suggestNextInvoiceNumber({ number: candidate, issueDate: todayIso }, todayIso);
  }
  return null;
}
