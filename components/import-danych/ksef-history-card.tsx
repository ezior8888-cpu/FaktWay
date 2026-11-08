import Link from 'next/link';
import {
  RiAlertLine,
  RiErrorWarningLine,
  RiPauseCircleLine,
  RiPlayCircleLine,
  RiShieldKeyholeLine,
  RiTimeLine,
} from '@remixicon/react';

import { setKsefHistoryPausedAction } from '@/app/actions/import-danych';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import type {
  KsefHistoryBlockedItem,
  KsefHistoryDeferredItem,
  KsefHistoryStreamStatus,
  KsefHistorySyncStatus,
} from '@/lib/ksef/history-sync/status';
import { SUPPORT_EMAIL } from '@/lib/site';
import { cn } from '@/lib/utils';

import {
  blockedReasonText,
  certificateState,
  deferredReasonText,
  errorMessage,
  exportNotice,
  formatLastFetch,
  historyBadge,
  importedSoFarText,
  itemMeta,
  listCapNote,
  needsClientAction,
  NO_CERTIFICATE_TEXT,
  PAUSE_ERROR_TEXT,
  PAUSE_MFA_TEXT,
  pausedText,
  phaseLines,
  progressInfo,
  rateLimitText,
  rateLines,
  READ_FAILURE_TEXT,
  RECEIVABLES_NOTE,
  retiredDraftLine,
  SECTION_TITLES,
  SECURITY_SETTINGS_HREF,
  SETTINGS_KSEF_HREF,
  showsReceivablesNote,
  STUCK_TEXT,
  UNCONFIRMED_CERTIFICATE_TEXT,
  type HistoryBadge,
  type PauseError,
  type ReasonText,
} from './ksef-history-model';

/**
 * Karta „Historia z KSeF” na ekranie Import danych (decyzja Bartosza
 * 22.10.2026: Magiczny import znika — FaktWay sam pobiera z KSeF całą
 * historię sprzedaży i zakupów certyfikatem firmy, a potem na bieżąco
 * sprzedaż wystawioną poza FaktWay).
 *
 * Server Component bez JS po stronie przeglądarki: listy w `<details>`,
 * wstrzymanie i wznowienie to zwykły formularz z akcją serwera
 * (`setKsefHistoryPausedAction` — tylko właściciel z potwierdzonym 2FA).
 * Wszystkie zdania są w `ksef-history-model.ts`; tu tylko układ.
 *
 * Każda blokada ma wyjście: błąd certyfikatu prowadzi do ustawień KSeF,
 * konflikt numeru — do dokumentu w FaktWay, a reszta mówi, że sprawdza to
 * nasz zespół (alarm operatora) albo podaje adres pomocy. Certyfikat bez
 * potwierdzenia dla tego środowiska KSeF (cron go pomija) prowadzi do
 * ponownego wgrania, a wstrzymanie bez 2FA — do ustawień bezpieczeństwa.
 */

export interface KsefHistoryCardProps {
  hasCertificate: boolean;
  /**
   * Certyfikat potwierdzony dla skonfigurowanego środowiska KSeF
   * (`hasConfiguredKsefProof`) — tylko takim firmom cron pobiera historię.
   */
  certificateConfirmed: boolean;
  /** `null` — stanu nie udało się wczytać. */
  status: KsefHistorySyncStatus | null;
  isOwner: boolean;
  /** `?wstrzymanie=blad|2fa` — poprzednia zmiana ustawienia się nie udała. */
  pauseError: PauseError | null;
  now?: Date;
}

const BADGE_TONE: Record<HistoryBadge['tone'], string> = {
  ok: 'bg-green-600/10 text-green-700 dark:bg-green-400/10 dark:text-green-400',
  wait: 'bg-amber-600/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-400',
  muted: 'bg-muted text-muted-foreground',
};

const WARNING_ALERT = 'border-amber-600/30 text-amber-700 dark:border-amber-400/30 dark:text-amber-400';

/** Zdanie z adresem pomocy jako linkiem `mailto:` (tekst bez zmian). */
function WithSupportLink({ text }: { text: string }) {
  const index = text.indexOf(SUPPORT_EMAIL);
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <a href={`mailto:${SUPPORT_EMAIL}`} className="underline underline-offset-2">
        {SUPPORT_EMAIL}
      </a>
      {text.slice(index + SUPPORT_EMAIL.length)}
    </>
  );
}

function SettingsLink() {
  return (
    <Link href={SETTINGS_KSEF_HREF} className="text-foreground font-medium underline underline-offset-2">
      Przejdź do ustawień KSeF
    </Link>
  );
}

function PauseForm({ paused }: { paused: boolean }) {
  return (
    <form action={setKsefHistoryPausedAction}>
      <input type="hidden" name="paused" value={paused ? '0' : '1'} />
      <Button type="submit" variant="outline" size="sm">
        {paused ? <RiPlayCircleLine aria-hidden /> : <RiPauseCircleLine aria-hidden />}
        {paused ? 'Wznów pobieranie' : 'Wstrzymaj pobieranie historii'}
      </Button>
    </form>
  );
}

function StreamSection({
  stream,
  status,
  paused,
  blocked,
  now,
}: {
  stream: KsefHistoryStreamStatus;
  status: KsefHistorySyncStatus;
  paused: boolean;
  /** Pobieranie stoi przez błąd certyfikatu, który naprawia klient. */
  blocked: boolean;
  now: Date;
}) {
  const title = SECTION_TITLES[stream.direction];
  const lines = phaseLines(stream, { outgoingEnabledAt: status.outgoing.enabledAt, paused, blocked, now });
  const progress = progressInfo(stream);
  const rate = rateLines(stream, paused || blocked);
  // Błąd „internal” całej firmy mówi to samo — nie powtarzamy zdania w obu sekcjach.
  // Przy błędzie certyfikatu „nic nie musisz robić” byłoby nieprawdą — klient ma działać.
  const stuck = stream.stuck && !paused && !blocked && status.error?.code !== 'internal';

  return (
    <section aria-label={`Historia z KSeF: ${title}`} className="flex flex-col gap-2 border p-3">
      <h3 className="text-sm font-medium">{title}</h3>
      {lines.map((line) => (
        <p key={line} className="text-muted-foreground text-sm">
          <WithSupportLink text={line} />
        </p>
      ))}
      {stuck ? <p className="text-sm text-amber-700 dark:text-amber-400">{STUCK_TEXT}</p> : null}
      {progress ? (
        <div className="space-y-1.5">
          <p className="text-xs tabular-nums">{progress.label}</p>
          <Progress
            value={progress.percent}
            aria-label={`${title}: ${progress.label}`}
            className="*:data-[slot=progress-track]:h-1.5"
          />
        </div>
      ) : null}
      {rate.map((line) => (
        <p key={line} className="text-muted-foreground text-xs">
          {line}
        </p>
      ))}
      {showsReceivablesNote(stream) ? <p className="text-muted-foreground text-xs">{RECEIVABLES_NOTE}</p> : null}
    </section>
  );
}

function ItemRow({
  item,
  reason,
}: {
  item: KsefHistoryBlockedItem | KsefHistoryDeferredItem;
  reason: ReasonText;
}) {
  return (
    <li className="flex flex-col gap-0.5 px-3 py-2">
      <p className="text-sm">
        <span className="font-mono font-medium">{item.invoiceNumber}</span>
        <span className="text-muted-foreground text-xs"> · {itemMeta(item)}</span>
      </p>
      <p className="text-muted-foreground text-xs">
        <WithSupportLink text={reason.text} />
      </p>
      {reason.invoiceHref ? (
        <Link href={reason.invoiceHref} className="text-primary w-fit text-xs font-medium underline-offset-4 hover:underline">
          Otwórz dokument
        </Link>
      ) : null}
    </li>
  );
}

function ItemList<T extends KsefHistoryBlockedItem | KsefHistoryDeferredItem>({
  summary,
  items,
  total,
  reasonOf,
}: {
  summary: string;
  items: readonly T[];
  total: number;
  reasonOf: (item: T) => ReasonText;
}) {
  const cap = listCapNote(items.length, total);
  return (
    <details className="group border">
      <summary className="hover:bg-muted cursor-pointer px-3 py-2 text-sm font-medium">{summary}</summary>
      <ul className="divide-y border-t">
        {items.map((item) => (
          <ItemRow key={`${item.direction}:${item.ksefNumber}`} item={item} reason={reasonOf(item)} />
        ))}
      </ul>
      {cap ? <p className="text-muted-foreground border-t px-3 py-2 text-xs">{cap}</p> : null}
    </details>
  );
}

function NoCertificate({ status }: { status: KsefHistorySyncStatus | null }) {
  const soFar = importedSoFarText(status);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">{NO_CERTIFICATE_TEXT}</p>
      {soFar ? <p className="text-muted-foreground text-sm">{soFar}</p> : null}
      <Link href={SETTINGS_KSEF_HREF} className={cn(buttonVariants({ variant: 'default', size: 'sm' }), 'w-fit')}>
        <RiShieldKeyholeLine aria-hidden />
        Wgraj certyfikat KSeF
      </Link>
    </div>
  );
}

/**
 * Certyfikat jest, ale bez potwierdzenia dla tego środowiska KSeF — cron go
 * pomija, więc nie obiecujemy startu, tylko prosimy o ponowne wgranie.
 */
function UnconfirmedCertificate({ status }: { status: KsefHistorySyncStatus | null }) {
  const soFar = importedSoFarText(status);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">{UNCONFIRMED_CERTIFICATE_TEXT}</p>
      {soFar ? <p className="text-muted-foreground text-sm">{soFar}</p> : null}
      <Link href={SETTINGS_KSEF_HREF} className={cn(buttonVariants({ variant: 'default', size: 'sm' }), 'w-fit')}>
        <RiShieldKeyholeLine aria-hidden />
        Wgraj certyfikat ponownie
      </Link>
    </div>
  );
}

function PauseErrorAlert({ kind }: { kind: PauseError }) {
  if (kind === 'mfa') {
    return (
      <Alert className={WARNING_ALERT}>
        <RiShieldKeyholeLine aria-hidden />
        <AlertDescription className="flex flex-col gap-1">
          <span>{PAUSE_MFA_TEXT}</span>
          <Link href={SECURITY_SETTINGS_HREF} className="text-foreground font-medium underline underline-offset-2">
            Ustaw logowanie dwuetapowe
          </Link>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="destructive">
      <AlertDescription>{PAUSE_ERROR_TEXT}</AlertDescription>
    </Alert>
  );
}

function ReadFailure() {
  return (
    <Alert variant="destructive">
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        <span>{READ_FAILURE_TEXT}</span>
        <Link href="/import-danych" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'text-foreground')}>
          Odśwież
        </Link>
      </AlertDescription>
    </Alert>
  );
}

function SyncState({ status, isOwner, now }: { status: KsefHistorySyncStatus; isOwner: boolean; now: Date }) {
  const paused = Boolean(status.clientPausedAt);
  // Błąd certyfikatu (odrzucony, wygasły, bez uprawnienia): runner nie woła KSeF —
  // sekcje mówią same fakty, bez „szukamy dalej”, tempa i obietnic (jak przy wstrzymaniu).
  const blocked = needsClientAction(status);
  const error = errorMessage(status.error);
  // „Wznowimy o …” byłoby obietnicą bez pokrycia, gdy po wznowieniu i tak zatrzyma nas certyfikat.
  const rateLimit = paused || blocked ? null : rateLimitText(status.rateLimitedUntil, now);
  const notice = exportNotice(status.periodsChangedAfterExport);
  const retired = retiredDraftLine(status);

  return (
    <div className="flex flex-col gap-4">
      {status.clientPausedAt ? (
        <Alert role="status" className="bg-muted/50">
          <RiPauseCircleLine aria-hidden />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{pausedText(status.clientPausedAt, blocked)}</span>
            {isOwner ? <PauseForm paused /> : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <Alert
          variant={error.tone === 'destructive' ? 'destructive' : 'default'}
          className={error.tone === 'warning' ? WARNING_ALERT : undefined}
        >
          <RiErrorWarningLine aria-hidden />
          <AlertDescription className="flex flex-col gap-1">
            <span>{error.text}</span>
            {error.settingsLink ? <SettingsLink /> : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {rateLimit ? (
        <Alert role="status" className={WARNING_ALERT}>
          <RiTimeLine aria-hidden />
          <AlertDescription>{rateLimit}</AlertDescription>
        </Alert>
      ) : null}

      {notice ? (
        <Alert role="note" className={WARNING_ALERT}>
          <RiAlertLine aria-hidden />
          <AlertDescription>
            {notice.lead}
            <Link href="/reports/exports" className="underline underline-offset-2">
              {notice.regenerate}
            </Link>
            {notice.rest}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <StreamSection stream={status.outgoing} status={status} paused={paused} blocked={blocked} now={now} />
        <StreamSection stream={status.incoming} status={status} paused={paused} blocked={blocked} now={now} />
      </div>

      {retired ? <p className="text-muted-foreground text-xs">{retired}</p> : null}

      {status.deferredTotal > 0 ? (
        <ItemList
          summary={`Czekają na rozstrzygnięcie (${status.deferredTotal})`}
          items={status.deferred}
          total={status.deferredTotal}
          reasonOf={deferredReasonText}
        />
      ) : null}

      {status.blockedTotal > 0 ? (
        <ItemList
          summary={`Faktury, których nie pobraliśmy (${status.blockedTotal})`}
          items={status.blocked}
          total={status.blockedTotal}
          reasonOf={blockedReasonText}
        />
      ) : null}

      {isOwner && !paused ? <PauseForm paused={false} /> : null}
    </div>
  );
}

export function KsefHistoryCard({
  hasCertificate,
  certificateConfirmed,
  status,
  isOwner,
  pauseError,
  now = new Date(),
}: KsefHistoryCardProps) {
  const certificate = certificateState(hasCertificate, certificateConfirmed);
  const badge = historyBadge(certificate, status);
  const lastSuccessAt = status?.outgoing.lastSuccessAt ?? status?.incoming.lastSuccessAt ?? null;

  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-base font-semibold">
          <h2>Historia z KSeF</h2>
        </CardTitle>
        <CardDescription>
          {hasCertificate && lastSuccessAt ? `Ostatnie pobranie: ${formatLastFetch(lastSuccessAt)}` : 'Sprzedaż i zakupy z KSeF'}
        </CardDescription>
        <CardAction>
          <Badge className={BADGE_TONE[badge.tone]}>{badge.label}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {pauseError ? <PauseErrorAlert kind={pauseError} /> : null}
        {certificate === 'missing' ? (
          <NoCertificate status={status} />
        ) : certificate === 'unconfirmed' ? (
          <UnconfirmedCertificate status={status} />
        ) : status ? (
          <SyncState status={status} isOwner={isOwner} now={now} />
        ) : (
          <ReadFailure />
        )}
      </CardContent>
    </Card>
  );
}
