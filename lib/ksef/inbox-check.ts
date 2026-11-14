import 'server-only';

import { requestInboxPoll } from '@/lib/ksef/inbox-activity';

/**
 * „Sprawdź teraz” w skrzynce KSeF, wspólne dla akcji strony
 * (`requestInboxCheckAction`) i API telefonu (`POST
 * /api/mobile/v1/skrzynka/sprawdz`, M10a). Logika przeniesiona z akcji bez
 * zmian: przyspiesza termin firmy, najwyżej raz na 5 minut. Faktury pobiera
 * worker, więc odpowiedź mówi tylko, że sprawdzamy. Firma już sprawdzona
 * (członkostwo); RPC jest tylko dla serwera. Ponowienie: limit 5 minut
 * i stan „w toku” w terminie firmy.
 */

export interface InboxCheckResult {
  status: 'accepted' | 'in_flight' | 'too_soon' | 'no_ksef' | 'error';
  message: string;
  retryAfterSeconds?: number;
}

function tooSoonMessage(retryAfterSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `KSeF sprawdzamy właśnie albo sprawdzaliśmy przed chwilą. Spróbuj ponownie za ${minutes} min.`;
}

export async function requestInboxCheck(tenantId: string): Promise<InboxCheckResult> {
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
