import { createAdminClient } from '@/lib/supabase/server';

/**
 * DB helpers dla support_conversations / support_messages (migracja 00054).
 *
 * Wszystko przez admin client (service_role) — INSERT/UPDATE są REVOKED
 * dla `authenticated`. API route woła te helpery PO weryfikacji
 * `auth.getUser()`.
 */

export type SupportRole = 'user' | 'assistant' | 'system';

export interface SupportMessageRow {
  id: string;
  conversation_id: string;
  role: SupportRole;
  content: string;
  cited_articles: string[] | null;
  ai_uncertain: boolean;
  created_at: string;
}

export interface SupportConversationRow {
  id: string;
  user_id: string | null;
  tenant_id: string | null;
  status: 'open' | 'escalated' | 'resolved' | 'closed';
  category: string | null;
  subject: string | null;
  /** `ai_uncertain` (czat sam eskalował) albo `user_requested` (klient poprosił o człowieka). */
  escalation_reason: string | null;
  created_at: string;
}

interface ConversationsClient {
  from: (n: 'support_conversations' | 'support_messages') => {
    select: (c: string) => {
      eq: (
        k: string,
        v: string,
      ) => {
        maybeSingle: () => Promise<{
          data: SupportConversationRow | null;
          error: { message: string } | null;
        }>;
        order: (
          k: string,
          opts: { ascending: boolean },
        ) => Promise<{
          data: SupportMessageRow[] | null;
          error: { message: string } | null;
        }>;
      };
    };
    insert: (rows: Array<Record<string, unknown>>) => {
      select: (c: string) => {
        maybeSingle: () => Promise<{
          data: { id: string } | null;
          error: { message: string } | null;
        }>;
      };
    };
    update: (patch: Record<string, unknown>) => {
      eq: (k: string, v: string) => Promise<{ error: { message: string } | null }>;
    };
  };
}

/** Tworzy nową konwersację, zwraca jej id. */
export async function createConversation(opts: {
  userId: string;
  tenantId: string | null;
  subject: string;
}): Promise<string> {
  const admin = createAdminClient() as unknown as ConversationsClient;
  const ins = await admin
    .from('support_conversations')
    .insert([
      {
        user_id: opts.userId,
        tenant_id: opts.tenantId,
        subject: opts.subject.slice(0, 200),
        status: 'open',
      },
    ])
    .select('id')
    .maybeSingle();
  if (ins.error || !ins.data) {
    throw new Error(`conversation_create_failed: ${ins.error?.message}`);
  }
  return ins.data.id;
}

/** Zwraca konwersację jeśli należy do usera (ownership check). */
export async function getOwnedConversation(
  conversationId: string,
  userId: string,
): Promise<SupportConversationRow | null> {
  const admin = createAdminClient() as unknown as ConversationsClient;
  const res = await admin
    .from('support_conversations')
    .select('id, user_id, tenant_id, status, category, subject, escalation_reason, created_at')
    .eq('id', conversationId)
    .maybeSingle();
  if (res.error || !res.data) return null;
  if (res.data.user_id !== userId) return null;
  return res.data;
}

/** Wszystkie wiadomości konwersacji, chronologicznie. */
export async function getMessages(
  conversationId: string,
): Promise<SupportMessageRow[]> {
  const admin = createAdminClient() as unknown as ConversationsClient;
  const res = await admin
    .from('support_messages')
    .select('id, conversation_id, role, content, cited_articles, ai_uncertain, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  return res.data ?? [];
}

export interface AppendMessageInput {
  conversationId: string;
  role: SupportRole;
  content: string;
  citedArticles?: string[];
  aiUncertain?: boolean;
}

export async function appendMessage(input: AppendMessageInput): Promise<void> {
  const admin = createAdminClient() as unknown as ConversationsClient;
  // `.select('id').maybeSingle()` — reużywamy tej samej sygnatury co create,
  // żeby typ insert był spójny (zwrot z błędem).
  const ins = await admin
    .from('support_messages')
    .insert([
      {
        conversation_id: input.conversationId,
        role: input.role,
        content: input.content,
        cited_articles: input.citedArticles ?? null,
        ai_uncertain: input.aiUncertain ?? false,
      },
    ])
    .select('id')
    .maybeSingle();
  if (ins.error) {
    throw new Error(`message_append_failed: ${ins.error.message}`);
  }

  // Bump updated_at konwersacji — sortowanie w admin /support.
  await admin
    .from('support_conversations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', input.conversationId);
}

/**
 * Zmiana statusu/kategorii/eskalacji — używane w Kroku 7.
 *
 * Klient Supabase nie rzuca przy błędzie, tylko zwraca `error`. Bez tego
 * sprawdzenia nieudany zapis wyglądał jak udany i klient widział „Zgłoszono”.
 */
export async function updateConversation(
  conversationId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const admin = createAdminClient() as unknown as ConversationsClient;
  const { error } = await admin
    .from('support_conversations')
    .update(patch)
    .eq('id', conversationId);
  if (error) {
    throw new Error(`conversation_update_failed: ${error.message}`);
  }
}
