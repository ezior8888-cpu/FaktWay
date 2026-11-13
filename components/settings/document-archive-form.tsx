'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RiDownloadLine, RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { getDocumentArchiveLinkAction, requestDocumentArchiveAction } from '@/app/actions/archiwum';
import { getDocumentArchiveStatusesAction } from '@/app/actions/job-statuses';
import { Button } from '@/components/ui/button';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useStatusPoll } from '@/hooks/use-status-poll';
import {
  ARCHIVE_KIND_LABELS,
  ARCHIVE_LINK_DAYS,
  ARCHIVE_MIN_MONTH,
  archivePeriod,
  archivePeriodLabel,
  archivePlDate,
  type ArchiveKind,
} from '@/lib/archiwum/okres';
import type { ArchiveOrderRow } from '@/lib/archiwum/zlecenia';
import { ARCHIVE_POLL } from '@/lib/polling/poll-loop';

/**
 * Archiwum dokumentów i paczka na kontrolę (plan kompletnej aplikacji, krok
 * 6.4, część 1) w zakładce „Firma”. Według decyzji D1: wiersze `Field` jak
 * reszta ustawień, bez zmiany istniejących sekcji; w telefonie pola stoją
 * jedno pod drugim. Stan zleceń bez plakietek, zwykłym tekstem.
 */

const KIND_ITEMS = [
  { value: 'archive', label: ARCHIVE_KIND_LABELS.archive },
  { value: 'audit', label: `${ARCHIVE_KIND_LABELS.audit} (z JPK_FA)` },
];
const FIRST_YEAR = 2022;
const MONTHS = 'months';

function warsawDay(iso: string): string {
  return new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
}

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

function describe(order: ArchiveOrderRow, now: number): string {
  if (order.status === 'pending' || order.status === 'generating') {
    return 'W przygotowaniu. Wyślemy e-mail, gdy paczka będzie gotowa.';
  }
  if (order.status === 'failed') return `Nie powstała. ${order.error_message ?? 'Zleć ją ponownie.'}`;
  const until = order.expires_at ? archivePlDate(warsawDay(order.expires_at)) : '';
  // Plik usunięty z magazynu po wygaśnięciu linku (00190); wiersz zostaje jako historia.
  if (order.file_deleted_at) return `Link wygasł ${until}, a plik paczki usunęliśmy. Zleć paczkę ponownie.`;
  if (!order.expires_at || new Date(order.expires_at).getTime() <= now) {
    return `Link wygasł ${until}. Zleć paczkę ponownie.`;
  }
  const gaps = order.missing_count ? ' Braki opisuje plik CO-JEST-W-PACZCE.txt w paczce.' : '';
  return `Gotowa: plików ${order.files_count ?? 0}, braków ${order.missing_count ?? 0}, ${size(order.size_bytes ?? 0)}. Link działa do ${until}.${gaps}`;
}

function isReady(order: ArchiveOrderRow, now: number): boolean {
  return (
    order.status === 'completed' &&
    !order.file_deleted_at &&
    Boolean(order.expires_at) &&
    new Date(order.expires_at!).getTime() > now
  );
}

export function DocumentArchiveForm({
  canRequest,
  orders,
  today,
}: {
  /** Właściciel i administrator; pozostali widzą tylko informację. */
  canRequest: boolean;
  orders: ArchiveOrderRow[];
  /** Dziś w Europe/Warsaw (RRRR-MM-DD). */
  today: string;
}) {
  const router = useRouter();
  const currentYear = Number(today.slice(0, 4));
  const currentMonth = today.slice(0, 7);
  const periodItems = [
    ...Array.from({ length: Math.max(1, currentYear - FIRST_YEAR + 1) }, (_, i) => {
      const year = String(currentYear - i);
      return { value: year, label: `Rok ${year}` };
    }),
    { value: MONTHS, label: 'Wybrane miesiące' },
  ];
  const [kind, setKind] = useState<string>('archive');
  const [period, setPeriod] = useState<string>(String(currentYear));
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01`);
  const [to, setTo] = useState(currentMonth);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [downloading, startDownload] = useTransition();
  const [now, setNow] = useState(() => Date.now());

  // Zlecenie w przygotowaniu: lekkie pytanie o status (15 s, 22,5 s, 33,75 s,
  // 50,6 s, potem co minutę, tylko na widocznej karcie), a listę odświeżamy
  // raz, gdy status się zmieni (plan skalowania, sesja 11; dawniej
  // `router.refresh()` co 15 s, także w tle).
  useStatusPoll({
    jobs: orders.filter((o) => o.status === 'pending' || o.status === 'generating'),
    read: getDocumentArchiveStatusesAction,
    schedule: ARCHIVE_POLL,
    onChange: () => setNow(Date.now()),
  });

  if (!canRequest) {
    return (
      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel>Archiwum dokumentów</FieldLabel>
          <FieldDescription>
            Paczkę ZIP z dokumentami firmy za okres zleci i pobierze właściciel albo administrator firmy.
          </FieldDescription>
        </FieldContent>
      </Field>
    );
  }

  const submit = () => {
    const range =
      period === MONTHS
        ? { from, to }
        : { from: `${period}-01`, to: period === String(currentYear) ? currentMonth : `${period}-12` };
    const checked = archivePeriod(range, today);
    if ('error' in checked) {
      setFieldError(checked.error);
      return;
    }
    setFieldError(null);
    startTransition(async () => {
      const result = await requestDocumentArchiveAction({ kind, ...range });
      if (result.success) {
        toast.success('Przygotowujemy paczkę. Wyślemy e-mail, gdy będzie gotowa.');
        setNow(Date.now());
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  const download = (id: string) => {
    startDownload(async () => {
      const result = await getDocumentArchiveLinkAction(id);
      if (result.success) window.location.assign(result.url);
      else toast.error(result.error);
    });
  };

  return (
    <>
      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel htmlFor="archive-kind">Archiwum dokumentów</FieldLabel>
          <FieldDescription id="archive-help">
            Paczka ZIP za wybrany okres: faktury sprzedaży i zakupu (plik XML z KSeF, PDF, UPO), lista faktur w CSV
            i zdjęcia kosztów. Paczka na kontrolę ma dodatkowo JPK_FA za ten okres. Przygotowanie trwa kilka minut;
            wyślemy e-mail, gdy paczka będzie gotowa, a link do pobrania działa {ARCHIVE_LINK_DAYS} dni. Potem usuwamy
            plik paczki, a dokumenty zostają w FaktWay. Brakujące pliki opisuje spis w paczce.
          </FieldDescription>
        </FieldContent>
        <div className="flex w-full flex-col gap-2 sm:w-64">
          <Select items={KIND_ITEMS} value={kind} disabled={pending} onValueChange={(value) => value && setKind(value)}>
            <SelectTrigger id="archive-kind" className="w-full" aria-describedby="archive-help">
              <SelectValue placeholder="Rodzaj paczki" />
            </SelectTrigger>
            <SelectContent className="p-1" alignItemWithTrigger={false}>
              <SelectGroup>
                {KIND_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select items={periodItems} value={period} disabled={pending} onValueChange={(value) => value && setPeriod(value)}>
            <SelectTrigger className="w-full" aria-label="Okres paczki">
              <SelectValue placeholder="Okres" />
            </SelectTrigger>
            <SelectContent className="p-1" alignItemWithTrigger={false}>
              <SelectGroup>
                {periodItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {period === MONTHS ? (
            <div className="flex gap-2">
              <Input
                type="month"
                aria-label="Pierwszy miesiąc"
                min={ARCHIVE_MIN_MONTH}
                max={currentMonth}
                value={from}
                disabled={pending}
                onChange={(e) => setFrom(e.target.value)}
              />
              <Input
                type="month"
                aria-label="Ostatni miesiąc"
                min={ARCHIVE_MIN_MONTH}
                max={currentMonth}
                value={to}
                disabled={pending}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          ) : null}
          {fieldError ? (
            <p role="alert" className="text-destructive text-xs">
              {fieldError}
            </p>
          ) : null}
          <Button type="button" onClick={submit} disabled={pending}>
            {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : <RiDownloadLine aria-hidden />}
            {kind === 'audit' ? 'Pobierz paczkę na kontrolę' : 'Pobierz archiwum'}
          </Button>
        </div>
      </Field>

      {orders.length > 0 ? (
        <Field orientation="responsive" className="flex-col!">
          <FieldContent>
            <FieldLabel>Ostatnie paczki</FieldLabel>
          </FieldContent>
          <ul className="flex w-full! flex-col gap-2">
            {orders.map((order) => (
              <li
                key={order.id}
                className="flex flex-col gap-2 rounded-md border p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium">
                    {ARCHIVE_KIND_LABELS[order.kind as ArchiveKind] ?? ARCHIVE_KIND_LABELS.archive},{' '}
                    {archivePeriodLabel(order.period_start, order.period_end)}
                  </span>
                  <span className="text-muted-foreground text-xs">{describe(order, now)}</span>
                </div>
                {isReady(order, now) ? (
                  <Button type="button" variant="outline" size="sm" disabled={downloading} onClick={() => download(order.id)}>
                    {downloading ? <RiLoader4Line className="animate-spin" aria-hidden /> : <RiDownloadLine aria-hidden />}
                    Pobierz
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </Field>
      ) : null}
    </>
  );
}
