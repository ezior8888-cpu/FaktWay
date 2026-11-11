import type { SupabaseClient } from '@supabase/supabase-js';

import {
  EXPENSE_THREAD_LIMIT,
  EXPENSE_THREAD_ROLE_LABELS,
  THREAD_LOAD_ERROR,
  canUseExpenseThread,
  isExpenseCommentKind,
  type ExpenseThreadEntry,
  type ExpenseThreadLoad,
} from './expense-thread';

/**
 * Odczyt wątku przy koszcie (plan kompletnej aplikacji, krok 6.2, część 3,
 * 00192) klientem z sesji. RLS pokazuje wpisy aktywnej firmy tylko przy
 * koszcie widocznym dla czytającego; jawny filtr firmy i kosztu prowadzi
 * zapytanie po indeksie. 100 najnowszych wpisów, pokazanych od najstarszego.
 *
 * Nazwy autorów z `users`: RLS (00058) pokazuje osoby ze wspólnej aktywnej
 * firmy, więc kto odszedł z firmy, ma przy wpisie rolę z chwili wpisu, a konto
 * usunięte (autor `NULL`) napis „Konto usunięte”. Błąd odczytu nazw nie chowa
 * wątku: wpisy dostają wtedy role. Błąd odczytu wątku to stan błędu, nie pusta
 * lista.
 */

type Db = Pick<SupabaseClient, 'from'>;

const COLUMNS = 'id, kind, body, author_id, author_role, created_at, resolved_at, resolved_by';

interface Row {
  id: string;
  kind: ExpenseThreadEntry['kind'];
  body: string;
  author_id: string | null;
  author_role: string;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

function toRow(raw: Record<string, unknown>): Row | null {
  if (typeof raw.id !== 'string' || !isExpenseCommentKind(raw.kind)) return null;
  if (typeof raw.body !== 'string' || typeof raw.created_at !== 'string') return null;
  const id = (value: unknown) => (typeof value === 'string' && value ? value : null);
  return {
    id: raw.id,
    kind: raw.kind,
    body: raw.body,
    author_id: id(raw.author_id),
    author_role: typeof raw.author_role === 'string' ? raw.author_role : '',
    created_at: raw.created_at,
    resolved_at: id(raw.resolved_at),
    resolved_by: id(raw.resolved_by),
  };
}

function capitalized(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function roleLabel(role: string): string | null {
  return canUseExpenseThread(role) ? EXPENSE_THREAD_ROLE_LABELS[role] : null;
}

export async function loadExpenseThread(
  db: Db,
  input: { tenantId: string; expenseId: string; userId: string },
): Promise<ExpenseThreadLoad> {
  let raw: unknown;
  try {
    const { data, error } = await db
      .from('expense_comments')
      .select(COLUMNS)
      .eq('tenant_id', input.tenantId)
      .eq('expense_id', input.expenseId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(EXPENSE_THREAD_LIMIT);
    if (error) return { ok: false, error: THREAD_LOAD_ERROR };
    raw = data;
  } catch {
    return { ok: false, error: THREAD_LOAD_ERROR };
  }

  const fetched = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
  // Baza oddaje od najnowszego (limit bierze ostatnie), ekran czyta od najstarszego.
  const rows = [...fetched]
    .reverse()
    .map(toRow)
    .filter((row): row is Row => row !== null);

  const others = new Set<string>();
  for (const row of rows) {
    for (const person of [row.author_id, row.resolved_by]) {
      if (person && person !== input.userId) others.add(person);
    }
  }

  const names = new Map<string, string>();
  if (others.size > 0) {
    try {
      const { data, error } = await db.from('users').select('id, name').in('id', [...others]);
      if (!error && Array.isArray(data)) {
        for (const user of data as Array<{ id?: unknown; name?: unknown }>) {
          const name = typeof user.name === 'string' ? user.name.trim() : '';
          if (typeof user.id === 'string' && name) names.set(user.id, name);
        }
      }
    } catch {
      // Bez nazw wątek zostaje czytelny: przy wpisach są role.
    }
  }

  const person = (id: string | null): string => {
    if (id === null) return 'Konto usunięte';
    if (id === input.userId) return 'Ty';
    return names.get(id) ?? 'Osoba spoza firmy';
  };

  const entries = rows.map((row): ExpenseThreadEntry => {
    const role = roleLabel(row.author_role);
    let authorLabel: string;
    let authorRoleLabel = role;
    if (row.author_id === null) authorLabel = 'Konto usunięte';
    else if (row.author_id === input.userId) authorLabel = 'Ty';
    else if (names.has(row.author_id)) authorLabel = names.get(row.author_id)!;
    else if (role) {
      authorLabel = capitalized(role);
      authorRoleLabel = null;
    } else authorLabel = 'Osoba spoza firmy';

    const resolved = row.kind === 'document_request' && row.resolved_at !== null;
    return {
      id: row.id,
      kind: row.kind,
      body: row.body,
      createdAt: row.created_at,
      authorLabel,
      authorRoleLabel,
      mine: row.author_id !== null && row.author_id === input.userId,
      resolvedAt: resolved ? row.resolved_at : null,
      resolvedByLabel: resolved ? person(row.resolved_by) : null,
    };
  });

  return { ok: true, entries, truncated: fetched.length >= EXPENSE_THREAD_LIMIT };
}
