import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import { sendSlackAlert } from '@/lib/alerts/slack';
import { getActiveOrgIdFromCookies } from '@/lib/supabase/active-org';
import { createClient } from '@/lib/supabase/server';
import { checkRateLimit } from '@/lib/rate-limit';
import { filterValidCitations } from '@/lib/support/knowledge-base';
import {
  parseMeta,
  streamSupportReply,
  type SupportTurn,
} from '@/lib/support/chat';
import {
  appendMessage,
  createConversation,
  getMessages,
  getOwnedConversation,
  updateConversation,
} from '@/lib/support/conversations';

/**
 * POST /api/support/chat — AI support chat (Faza 30).
 *
 * Body: { conversationId?: string, message: string }
 * Response: streaming text/plain. Nagłówek `X-Conversation-Id` zwraca id
 * konwersacji (klient używa go w kolejnych wiadomościach).
 *
 * Flow:
 *   1. auth + rate limit (30/10min/user)
 *   2. nowa konwersacja albo ownership check istniejącej
 *   3. zapis wiadomości usera
 *   4. stream odpowiedzi AI z KB w kontekście
 *   5. po streamie: parse META → zapis odpowiedzi z cytowaniami
 */

const bodySchema = z.object({
  conversationId: z.string().uuid().optional(),
  message: z.string().min(1).max(2000),
});

// Maks. liczba wiadomości historii wysyłanych do modelu — chroni przed
// rozdmuchaniem kontekstu w długiej konwersacji.
const MAX_HISTORY_TURNS = 20;

async function memberOrgOrNull(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  orgId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('memberships')
    .select('organization_id')
    .eq('user_id', userId)
    .eq('organization_id', orgId)
    .eq('status', 'active')
    .maybeSingle();
  return data ? orgId : null;
}

export async function POST(req: Request): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'not_authenticated' }, { status: 401 });
  }

  const rl = await checkRateLimit({
    bucket: 'support_chat',
    identifier: user.id,
    limit: 30,
    windowSeconds: 10 * 60,
  });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', retryAfter: rl.retryAfter },
      { status: 429 },
    );
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  // Konwersacja: istniejąca (ownership check) albo nowa.
  let conversationId: string;
  let history: SupportTurn[] = [];
  // Prośba klienta o człowieka nie może zamienić się w „czat nie wiedział”.
  let klientProsilOCzlowieka = false;

  if (parsed.conversationId) {
    const conv = await getOwnedConversation(parsed.conversationId, user.id);
    if (!conv) {
      return NextResponse.json(
        { error: 'conversation_not_found' },
        { status: 404 },
      );
    }
    conversationId = conv.id;
    klientProsilOCzlowieka = conv.escalation_reason === 'user_requested';
    const msgs = await getMessages(conversationId);
    history = msgs
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-MAX_HISTORY_TURNS)
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));
  } else {
    // AUD-104: cookie aktywnej firmy ustawia klient — firma tylko po
    // sprawdzeniu aktywnego członkostwa, inaczej rozmowa bez firmy.
    const cookieOrg = await getActiveOrgIdFromCookies();
    const tenantId = cookieOrg ? await memberOrgOrNull(supabase, user.id, cookieOrg) : null;
    conversationId = await createConversation({
      userId: user.id,
      tenantId: tenantId ?? null,
      subject: parsed.message.slice(0, 120),
    });
  }

  // Zapis wiadomości usera PRZED streamem — zostaje w historii nawet gdy
  // generowanie odpowiedzi padnie.
  await appendMessage({
    conversationId,
    role: 'user',
    content: parsed.message,
  });

  history.push({ role: 'user', content: parsed.message });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let full = '';
      try {
        for await (const chunk of streamSupportReply(history)) {
          full += chunk;
          controller.enqueue(encoder.encode(chunk));
        }
      } catch (err) {
        Sentry.captureException(err, {
          tags: { route: 'support/chat', conversation_id: conversationId },
        });
        const fallback =
          '\n\nPrzepraszam, wystąpił błąd. Spróbuj ponownie za chwilę albo napisz do nas mailem.';
        full += fallback;
        controller.enqueue(encoder.encode(fallback));
      }

      // Zapis odpowiedzi PRZED close — gwarancja że trafi do DB.
      try {
        const meta = parseMeta(full);
        await appendMessage({
          conversationId,
          role: 'assistant',
          content: meta.cleanText,
          citedArticles: filterValidCitations(meta.articles),
          aiUncertain: meta.uncertain,
        });

        // Auto-kategoryzacja + eskalacja (Krok 7).
        const patch: Record<string, unknown> = {};
        if (meta.category) patch.category = meta.category;
        if (meta.uncertain && !klientProsilOCzlowieka) {
          patch.status = 'escalated';
          patch.escalated_at = new Date().toISOString();
          patch.escalation_reason = 'ai_uncertain';
        }
        if (Object.keys(patch).length > 0) {
          await updateConversation(conversationId, patch);
        }

        // AI nie znał odpowiedzi → sygnał dla zespołu na Slack #bugs.
        if (meta.uncertain) {
          await sendSlackAlert({
            channel: 'bugs',
            text: '🆘 AI support nie znał odpowiedzi — konwersacja eskalowana.',
            context: {
              conversation_id: conversationId,
              category: meta.category ?? 'unknown',
            },
          });
        }
      } catch (err) {
        Sentry.captureException(err, {
          tags: { route: 'support/chat', stage: 'persist' },
        });
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Conversation-Id': conversationId,
    },
  });
}
