'use server';

import { requestInboxPoll } from '@/lib/ksef/inbox-activity';
import { ActionAuthError, requireUserAndActiveOrg } from '@/lib/supabase/auth-context';

export interface InboxCheckResult {
  status: 'accepted' | 'in_flight' | 'too_soon' | 'no_ksef' | 'error';
  message: string;
  retryAfterSeconds?: number;
}

function tooSoonMessage(retryAfterSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Sprawdzaliśmy KSeF przed chwilą. Spróbuj ponownie za ${minutes} min.`;
}

/**
 * Przycisk „Sprawdź teraz” w Skrzynce KSeF: przyspiesza termin firmy, najwyżej
 * raz na 5 minut. Faktury pobiera worker, więc odpowiedź mówi tylko, że sprawdzamy.
 * Członkostwo sprawdza `requireUserAndActiveOrg`, RPC jest tylko dla serwera.
 */
export async function requestInboxCheckAction(): Promise<InboxCheckResult> {
  let tenantId: string;
  try {
    ({ tenantId } = await requireUserAndActiveOrg());
  } catch (error) {
    if (error instanceof ActionAuthError) return { status: 'error', message: error.message };
    throw error;
  }

  try {
    const result = await requestInboxPoll(tenantId);
    switch (result.status) {
      case 'accepted':
        return { status: 'accepted', message: 'Sprawdzamy KSeF. Nowe faktury pojawią się na liście za chwilę.' };
      case 'in_flight':
        return { status: 'in_flight', message: 'Właśnie sprawdzamy KSeF. Nowe faktury pojawią się na liście za chwilę.' };
      case 'too_soon':
        return { status: 'too_soon', message: tooSoonMessage(result.retryAfterSeconds), retryAfterSeconds: result.retryAfterSeconds };
      default:
        return { status: 'no_ksef', message: 'Podłącz KSeF w ustawieniach, żeby sprawdzać nowe faktury.' };
    }
  } catch (error) {
    console.error('[skrzynka] „Sprawdź teraz” nieudane', error instanceof Error ? error.message : String(error));
    return { status: 'error', message: 'Nie udało się sprawdzić KSeF. Spróbuj ponownie za chwilę.' };
  }
}
