'use server';

import { sendSlackAlert } from '@/lib/alerts/slack';
import { sendSupportEscalationEmail } from '@/lib/email/send';
import { ActionAuthError, requireVerifiedUser } from '@/lib/supabase/auth-context';
import { getOwnedConversation, updateConversation } from './conversations';

/**
 * Server Actions dla widgetu support (Faza 30 Krok 7).
 * Każda sprawdza ownership konwersacji przed zapisem — i sesję po drugim
 * kroku MFA, nie sam `getUser()` (AUD-58).
 */

export type SupportActionResult = { ok: boolean };

async function verifiedUser(): Promise<{ id: string; email?: string | null } | null> {
  try {
    return (await requireVerifiedUser()).user;
  } catch (e) {
    if (e instanceof ActionAuthError) return null;
    throw e;
  }
}

/**
 * CSAT — użytkownik ocenia konwersację 👍/👎. Negatywna ocena trafia
 * dodatkowo na Slack, żeby zespół mógł przejrzeć, co poszło nie tak.
 */
export async function submitCsatAction(
  conversationId: string,
  positive: boolean,
): Promise<SupportActionResult> {
  const user = await verifiedUser();
  if (!user) return { ok: false };

  const conv = await getOwnedConversation(conversationId, user.id);
  if (!conv) return { ok: false };

  try {
    await updateConversation(conversationId, { csat_positive: positive });
  } catch {
    return { ok: false };
  }

  if (!positive) {
    await sendSlackAlert({
      channel: 'bugs',
      text: '👎 Negatywna ocena rozmowy z AI support — warto przejrzeć.',
      context: {
        conversation_id: conversationId,
        category: conv.category ?? 'unknown',
      },
    });
  }

  return { ok: true };
}

/**
 * Ręczna eskalacja — użytkownik klika „Połącz z człowiekiem".
 * Oznacza konwersację jako `escalated` i alarmuje zespół: Slackiem oraz mailem
 * na adres pomocy (z adresem klienta do odpowiedzi).
 *
 * Trzy rzeczy, na których opiera się napis „Zgłoszono. Odezwiemy się mailem”:
 *  - rozmowa, którą czat sam eskalował (`ai_uncertain`), to NIE jest prośba
 *    klienta: tamten alert nie ma jego adresu, więc tu idzie własny. Bez
 *    dubla tylko przy powtórzonej prośbie (`user_requested`);
 *  - nieudany zapis to odmowa, nie „Zgłoszono”;
 *  - gdy żadna droga nie dotarła, `ok: false`: widget podaje adres zamiast
 *    obiecywać odpowiedź. Wiersz zostaje, operator widzi go w `/admin/support`.
 */
export async function escalateConversationAction(
  conversationId: string,
): Promise<SupportActionResult> {
  const user = await verifiedUser();
  if (!user) return { ok: false };

  const conv = await getOwnedConversation(conversationId, user.id);
  if (!conv) return { ok: false };

  // Klient już poprosił — nie duplikujemy alertu.
  if (conv.status === 'escalated' && conv.escalation_reason === 'user_requested') {
    return { ok: true };
  }

  try {
    await updateConversation(conversationId, {
      status: 'escalated',
      escalated_at: new Date().toISOString(),
      escalation_reason: 'user_requested',
    });
  } catch {
    return { ok: false };
  }

  const [slack, email] = await Promise.allSettled([
    sendSlackAlert({
      channel: 'bugs',
      text: '🙋 Użytkownik poprosił o kontakt z człowiekiem (support).',
      context: {
        conversation_id: conversationId,
        user_email: user.email ?? 'unknown',
        category: conv.category ?? 'unknown',
      },
    }),
    sendSupportEscalationEmail({
      conversationId,
      userEmail: user.email ?? null,
      subject: conv.subject,
      category: conv.category,
    }),
  ]);

  const delivered =
    (slack.status === 'fulfilled' && slack.value === true) ||
    (email.status === 'fulfilled' && email.value.sent === true);

  return { ok: delivered };
}
