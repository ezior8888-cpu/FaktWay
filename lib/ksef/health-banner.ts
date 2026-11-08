import type { KsefHealthPublic } from './health-status';

/**
 * Treść banera o stanie KSeF. Ogłoszenie MF (Latarnia) ma pierwszeństwo przed naszą sondą,
 * bo tylko ono wyznacza tryb prawny. Odpowiedź 503 z sondy nie jest ogłoszeniem MF.
 */
export interface KsefBannerContent {
  title: string;
  description: string;
  severity: 'critical' | 'warning';
}

const SENDING_HINT =
  'Wysyłka może się nie udać, a nowe faktury mogą pozostać szkicami. Po zakończeniu sprawdź stan dokumentów przed wysyłką.';

const WARSAW_DATE_TIME = new Intl.DateTimeFormat('pl-PL', {
  timeZone: 'Europe/Warsaw',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function formatEnd(end: string | null | undefined): string | null {
  if (!end) return null;
  const date = new Date(end);
  return Number.isNaN(date.getTime()) ? null : WARSAW_DATE_TIME.format(date);
}

export function ksefBannerContent(health: KsefHealthPublic): KsefBannerContent | null {
  switch (health.officialStatus) {
    case 'TOTAL_FAILURE':
      return {
        title: 'Ministerstwo Finansów ogłosiło awarię całkowitą KSeF',
        description:
          'Na czas tej awarii fakturę wystawiasz poza KSeF, na papierze albo elektronicznie, i nie dosyłasz jej później. W FaktWay nowe faktury mogą pozostać szkicami.',
        severity: 'critical',
      };
    case 'FAILURE':
      return {
        title: 'Ministerstwo Finansów ogłosiło awarię KSeF',
        description: SENDING_HINT,
        severity: 'critical',
      };
    case 'MAINTENANCE': {
      const end = formatEnd(health.officialEnd);
      return {
        title: 'Planowana przerwa w KSeF',
        description: end ? `Ministerstwo Finansów podaje koniec przerwy: ${end}. ${SENDING_HINT}` : SENDING_HINT,
        severity: health.level === 'down' ? 'critical' : 'warning',
      };
    }
    default:
      break;
  }

  if (health.level === 'down') {
    return {
      title: 'KSeF jest niedostępny',
      description:
        'Nowe faktury pozostaną szkicami. Automatyczny Offline24 jest wstrzymany; po przywróceniu KSeF sprawdź stan dokumentu przed wysyłką.',
      severity: 'critical',
    };
  }
  if (health.level === 'degraded') {
    return {
      title: 'KSeF działa wolno',
      description: `Pingi do KSeF trwają ${health.responseTimeMs ?? '?'}ms. Wysyłka faktur może być wolniejsza, ale działa.`,
      severity: 'warning',
    };
  }
  return null;
}

/** Schowany baner wraca, gdy zmieni się poziom albo stan ogłoszony przez MF. */
export function ksefBannerKey(health: KsefHealthPublic): string {
  return `${health.level}:${health.officialStatus ?? 'brak'}`;
}
