'use server';

import { z } from 'zod';

import { logAudit } from '@/lib/audit/log';
import { ANALYTICS_STATEMENT } from '@/lib/legal/versions';
import { createClient } from '@/lib/supabase/server';

const inputSchema = z.object({
  consent: z.enum(['granted', 'denied']).nullable(),
  chosenAt: z.string().datetime({ offset: true }).nullable(),
});

export type AnalyticsConsentSyncResult =
  | { status: 'anonymous' }
  | { status: 'unavailable' }
  | { status: 'ok'; consent: 'granted' | 'denied' | null; consentAt: string | null };

interface ConsentRow {
  consent: 'granted' | 'denied' | null;
  consent_at: string | null;
  changed: boolean;
}

/**
 * Zapis i odczyt zgody na analitykę zalogowanej osoby. `consent: null` to sam
 * odczyt (synchronizacja po zalogowaniu). Gość dostaje `anonymous`: jego wybór
 * zostaje w przeglądarce, a na konto trafi po zalogowaniu.
 */
export async function syncAnalyticsConsentAction(
  input: z.infer<typeof inputSchema>,
): Promise<AnalyticsConsentSyncResult> {
  // Akcję można wywołać z pominięciem interfejsu, więc wejście sprawdzamy tutaj.
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { status: 'unavailable' };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: 'anonymous' };

  const { data, error } = await supabase.rpc('sync_analytics_consent', {
    p_consent: parsed.data.consent,
    p_chosen_at: parsed.data.chosenAt,
  });
  const row = (data as ConsentRow[] | null)?.[0];
  if (error || !row) return { status: 'unavailable' };

  // Art. 7 ust. 1 RODO: umiemy wykazać, kiedy i na jakie brzmienie padła decyzja.
  if (row.changed) {
    await logAudit({
      action: 'analytics.consent_changed',
      tenantId: null,
      userId: user.id,
      metadata: {
        consent: row.consent,
        chosen_at: row.consent_at,
        statement_version: ANALYTICS_STATEMENT.version,
        via: 'banner_or_settings',
      },
    });
  }

  return { status: 'ok', consent: row.consent, consentAt: row.consent_at };
}
