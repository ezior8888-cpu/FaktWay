/**
 * Odesłanie ze starego raportu `/reports/kpir` do księgi modułu (plan
 * księgowości JDG, K8, decyzja D20): firma z modułem (obszar `ewidencja`)
 * ma jedną księgę, więc raport pokazuje, gdzie ona jest. Skala i liniowy:
 * KPiR modułu (gdy obszar `kpir` działa), ryczałt: ewidencja przychodów.
 * Firma bez modułu, bez ustawień albo przy błędzie odczytu: nic, raport
 * bez zmian.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { czytajWersjeProfilu } from '@/lib/ksiegowosc/profil';
import { wersjaMiesiaca } from '@/lib/ksiegowosc/ten-miesiac';
import { czyKsiegowoscWlaczona, statusObszaru } from '@/lib/ksiegowosc/wylacznik';

export interface OdeslanieDoKsiegi {
  tekst: string;
  /** Strona księgi modułu za ten sam miesiąc. */
  adres: string;
}

export async function odeslanieDoKsiegi(client: SupabaseClient, tenantId: string, miesiac: string): Promise<OdeslanieDoKsiegi | null> {
  try {
    if (!(await czyKsiegowoscWlaczona(client, tenantId, 'ewidencja')).wlaczony) return null;
    const forma = wersjaMiesiaca(await czytajWersjeProfilu(client, tenantId), miesiac)?.forma;
    if (!forma) return null;
    const adres = `/reports/ewidencja?month=${Number(miesiac.slice(5, 7))}&year=${miesiac.slice(0, 4)}`;
    if (forma === 'ryczalt') {
      return { tekst: 'Przy ryczałcie FaktWay prowadzi ewidencję przychodów; jest w zakładce „Ewidencja” razem z plikiem JPK_EWP.', adres };
    }
    if (!statusObszaru('kpir').wlaczony) return null;
    return {
      tekst:
        'KPiR według wzoru od 2026 r. (z numerem KSeF, wpisami ręcznymi, Funduszem Pracy, spisem z natury i plikiem JPK_PKPIR) jest w zakładce „Ewidencja”. ' +
        'Ten raport zostaje do podglądu dokumentów.',
      adres,
    };
  } catch {
    return null;
  }
}
