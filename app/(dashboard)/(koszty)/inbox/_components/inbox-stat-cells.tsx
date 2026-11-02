import { RiArrowRightUpLine, RiDownloadCloud2Line, RiFileEditLine, RiMailUnreadLine } from '@remixicon/react';

import { PULPIT_EMPTY } from '@/components/dashboard/pulpit/card-states';
import { loadStatCell, StatSlot } from '@/components/expenses/finora/stat-slot';
import { StatsCardsFrame } from '@/components/expenses/finora/stats-cards';
import {
  countExpensesToReview,
  getInboxMonthCosts,
  getInboxScheduleSummary,
  getLastInboxFetchAt,
} from '@/lib/dashboard/expense-stats';
import { trybDanych } from '@/lib/demo/tryb-danych';
import { formatPlCompactMoney, formatPlInt, formatPlMoney } from '@/lib/format/pl';
import { formatWarsawDateTime } from '@/lib/format/warsaw-date';
import { plural } from '@/lib/i18n/plural';
import type { PageContext } from '@/lib/supabase/page-context';

import { InboxCheckNowButton } from './inbox-check-now-button';

/**
 * Kafle Skrzynki KSeF (P9 ← Finora `transaction-stats-cards.tsx`): Nowe
 * faktury / Faktury kosztowe w miesiącu / Do opisania / Ostatnie pobranie
 * z KSeF. Kwota z `getCosts` (§2.4 pkt 12) przez `getInboxMonthCosts`;
 * każdy kafel we własnej granicy błędu (§2.4 pkt 15).
 */

export interface InboxStatsProps {
  supabase: PageContext['supabase'];
  tenantId: string;
  /** Użytkownik strony — tryb danych (weryfikacja KSeF) liczony dla `tenantId`. */
  user: Pick<PageContext['user'], 'id'>;
  now?: Date;
}

export async function InboxNewCell({ supabase, tenantId }: InboxStatsProps) {
  return loadStatCell('Nowe faktury', async () => {
    const count = await countExpensesToReview(supabase, tenantId, { source: 'ksef_inbox' });
    return {
      value: formatPlInt(count),
      note: count > 0 ? 'Faktury z KSeF jeszcze nieopisane' : 'Wszystkie faktury opisane',
      icon: RiMailUnreadLine,
    };
  });
}

export async function InboxMonthCostsCell({ supabase, tenantId, now }: InboxStatsProps) {
  return loadStatCell('Faktury kosztowe w miesiącu', async () => {
    const { gross, count } = await getInboxMonthCosts(supabase, tenantId, now);
    return {
      value: formatPlCompactMoney(gross),
      valueTitle: `${formatPlMoney(gross)} zł`,
      note: `Brutto · ${count} ${plural(count, ['faktura', 'faktury', 'faktur'])} w KPiR`,
      icon: RiArrowRightUpLine,
    };
  });
}

export async function InboxToReviewCell({ supabase, tenantId }: InboxStatsProps) {
  return loadStatCell('Do opisania', async () => {
    const count = await countExpensesToReview(supabase, tenantId);
    return {
      value: formatPlInt(count),
      note: 'Wszystkie wydatki, także paragony',
      icon: RiFileEditLine,
    };
  });
}

export async function InboxLastFetchCell({ supabase, tenantId, user, now }: InboxStatsProps) {
  return loadStatCell('Ostatnie pobranie z KSeF', async () => {
    const [last, schedule] = await Promise.all([
      getLastInboxFetchAt(supabase, tenantId),
      getInboxScheduleSummary(supabase, tenantId),
    ]);
    // Bez wiersza harmonogramu firma nie ma KSeF: nie ma czego sprawdzać.
    const action = schedule ? <InboxCheckNowButton /> : undefined;
    if (last) {
      return {
        value: formatWarsawDateTime(last),
        valueClassName: 'text-lg',
        // Data na kaflu to ostatnia faktura; samo sprawdzenie bez nowych faktur widać tu.
        // „Co 15 minut” jest prawdą dla tego, kto patrzy: aktywność w firmie robi ją gorącą.
        note: schedule?.lastCheckedAt
          ? `Ostatnie sprawdzenie: ${formatWarsawDateTime(schedule.lastCheckedAt)} · sprawdzamy KSeF co 15 minut`
          : 'Sprawdzamy KSeF co 15 minut',
        icon: RiDownloadCloud2Line,
        action,
      };
    }
    // Jedna funkcja trybu (lib/demo/tryb-danych.ts): „bez KSeF” = tryb przykładowy.
    const verified = (await trybDanych({ supabase, tenantId, user }, now ?? new Date())).tryb !== 'przyklad';
    return {
      value: '—',
      // Rytm pobierania mówił dawny podtytuł skrzynki; bez niego klient czekający
      // na pierwsze faktury dowiaduje się o nim tutaj.
      note: verified ? 'Jeszcze nie pobraliśmy żadnej faktury · sprawdzamy KSeF co 15 minut' : PULPIT_EMPTY.connectKsef,
      icon: RiDownloadCloud2Line,
      action,
    };
  });
}

export function InboxStatsCards({ className, ...props }: InboxStatsProps & { className?: string }) {
  return (
    <StatsCardsFrame
      className={className}
      cells={[
        <StatSlot key="new" label="Nowe faktury">
          <InboxNewCell {...props} />
        </StatSlot>,
        <StatSlot key="month" label="Faktury kosztowe w miesiącu">
          <InboxMonthCostsCell {...props} />
        </StatSlot>,
        <StatSlot key="review" label="Do opisania">
          <InboxToReviewCell {...props} />
        </StatSlot>,
        <StatSlot key="last" label="Ostatnie pobranie z KSeF">
          <InboxLastFetchCell {...props} />
        </StatSlot>,
      ]}
    />
  );
}
