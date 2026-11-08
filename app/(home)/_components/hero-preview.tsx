'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useInView } from 'framer-motion';
import {
  RiBarChartBoxLine,
  RiCheckLine,
  RiDashboardLine,
  RiFileList3Line,
  RiLoader4Line,
  RiNotification3Line,
  RiSearchLine,
  RiTeamLine,
  RiWallet3Line,
  type RemixiconComponentType,
} from '@remixicon/react';

import { cn } from '@/lib/utils';
import { usePrefersReducedMotion } from '@/hooks/use-media-query';

import { FaktWayLogo } from '@/components/brand/faktway-logo';
import { EASE_OUT } from '@/components/site/motion';

/*
 * Podgląd panelu pod nagłówkiem strony głównej (poprawka Bartosza 03.11.2026:
 * „strona wygląda pusto na początku”). Ilustracja układu panelu na komputerze:
 * pasek boczny, lista faktur i status KSeF, który sam przechodzi z kolejki
 * na przyjętą, czyli to, co obiecuje nagłówek. Firmy i kwoty są zmyślone, te
 * same co w makiecie telefonu niżej.
 */

type Status = 'kolejka' | 'wysylanie' | 'przyjeta';

const NAV: ReadonlyArray<{ label: string; icon: RemixiconComponentType }> = [
  { label: 'Pulpit', icon: RiDashboardLine },
  { label: 'Faktury', icon: RiFileList3Line },
  { label: 'Koszty', icon: RiWallet3Line },
  { label: 'Kontrahenci', icon: RiTeamLine },
  { label: 'Raporty', icon: RiBarChartBoxLine },
];

const NEW_ROW = { no: 'FV/2026/11/004', buyer: 'Przykładowa Firma sp. z o.o.', date: '03.11.2026', amount: '1 512,90 zł' };
const ROWS = [
  { no: 'FV/2026/11/003', buyer: 'Sklep Próbny', date: '03.11.2026', amount: '890,50 zł' },
  { no: 'FV/2026/11/002', buyer: 'Pracownia Wzór', date: '02.11.2026', amount: '2 460,00 zł' },
  { no: 'FV/2026/10/014', buyer: 'Przykładowa Firma sp. z o.o.', date: '24.10.2026', amount: '1 512,90 zł' },
];

/*
 * Pętla: nowa faktura wjeżdża na górę listy, czeka w kolejce, wysyła się
 * i zostaje przyjęta, a w rogu pojawia się potwierdzenie z UPO. Rusza, gdy
 * podgląd jest na ekranie; przy ograniczonym ruchu od razu stan końcowy.
 */
const PHASE_AT = [0, 900, 2000, 3600] as const;
const LOOP_MS = 8500;

const GRID =
  'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 sm:grid-cols-[8.5rem_minmax(0,1fr)_6.5rem_9rem] md:grid-cols-[8.5rem_minmax(0,1fr)_6rem_6.5rem_9rem]';

function StatusPill({ status }: { status: Status }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span
        key={status}
        className={cn(
          'inline-flex items-center gap-1 justify-self-end rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap',
          status === 'przyjeta' && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
          status === 'wysylanie' && 'bg-primary/10 text-primary',
          status === 'kolejka' && 'bg-muted text-muted-foreground',
        )}
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        transition={{ duration: 0.2 }}
      >
        {status === 'przyjeta' ? <RiCheckLine className="size-3.5" /> : null}
        {status === 'wysylanie' ? <RiLoader4Line className="size-3.5 animate-spin" /> : null}
        {status === 'przyjeta' ? 'Przyjęta w KSeF' : status === 'wysylanie' ? 'Wysyłanie…' : 'W kolejce'}
      </motion.span>
    </AnimatePresence>
  );
}

function Row({ row, status }: { row: (typeof ROWS)[number]; status: Status }) {
  return (
    <div className={cn(GRID, 'border-b border-border px-3 py-2.5 text-[12px] last:border-b-0')}>
      <div className="min-w-0">
        <p className="font-medium">{row.no}</p>
        <p className="truncate text-muted-foreground sm:hidden">{row.buyer}</p>
      </div>
      <p className="hidden truncate sm:block">{row.buyer}</p>
      <p className="hidden text-muted-foreground md:block">{row.date}</p>
      <p className="hidden text-right font-medium sm:block">{row.amount}</p>
      <StatusPill status={status} />
    </div>
  );
}

/** Zarys wiersza, zanim przyjdzie nowa faktura: te same kolumny co `Row`, bez danych. */
function SkeletonRow() {
  const bar = 'rounded bg-muted-foreground/15 animate-pulse motion-reduce:animate-none';
  return (
    <div className={cn(GRID, 'h-full px-3 py-2.5')}>
      <div className="min-w-0 space-y-1.5">
        <span className={cn(bar, 'block h-2.5 w-24')} />
        <span className={cn(bar, 'block h-2 w-32 max-w-full sm:hidden')} />
      </div>
      <span className={cn(bar, 'hidden h-2.5 w-40 max-w-full sm:block')} />
      <span className={cn(bar, 'hidden h-2.5 w-16 md:block')} />
      <span className={cn(bar, 'hidden h-2.5 w-16 justify-self-end sm:block')} />
      <span className={cn(bar, 'h-4 w-20 justify-self-end rounded-full')} />
    </div>
  );
}

export function HeroPreview() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.3 });
  const reducedMotion = usePrefersReducedMotion();
  const [phase, setPhase] = useState(0);
  const [cycle, setCycle] = useState(0);

  useEffect(() => {
    if (reducedMotion || !inView) return;
    const timers = PHASE_AT.slice(1).map((ms, i) => setTimeout(() => setPhase(i + 1), ms));
    timers.push(
      setTimeout(() => {
        setPhase(0);
        setCycle((current) => current + 1);
      }, LOOP_MS),
    );
    return () => timers.forEach(clearTimeout);
  }, [cycle, inView, reducedMotion]);

  const shown = reducedMotion ? 3 : phase;
  const newStatus: Status = shown >= 3 ? 'przyjeta' : shown === 2 ? 'wysylanie' : 'kolejka';

  return (
    <div ref={ref} aria-hidden className="relative isolate mx-auto mt-16 max-w-5xl text-left select-none sm:mt-20">
      <div className="absolute -inset-x-2 -top-8 bottom-6 -z-10 rounded-[3rem] bg-primary/15 blur-3xl sm:-inset-x-6" />
      <div className="overflow-hidden rounded-2xl bg-card text-card-foreground shadow-2xl shadow-primary/15 ring-1 ring-border">
        <div className="flex h-9 items-center gap-1.5 border-b border-border bg-muted/60 px-4">
          <span className="size-2.5 rounded-full bg-[#FF5F57]" />
          <span className="size-2.5 rounded-full bg-[#FEBC2E]" />
          <span className="size-2.5 rounded-full bg-[#28C840]" />
          <span className="mx-auto h-5 w-40 rounded-md bg-background ring-1 ring-border sm:w-64" />
          <span className="w-10" />
        </div>
        <div className="flex">
          <div className="hidden w-44 shrink-0 flex-col gap-0.5 border-r border-border bg-muted/30 p-3 md:flex">
            <FaktWayLogo className="mb-4 ml-1 h-5" />
            {NAV.map(({ label, icon: Icon }) => (
              <span
                key={label}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px]',
                  label === 'Faktury' ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground',
                )}
              >
                <Icon className="size-4" />
                {label}
              </span>
            ))}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex h-11 items-center justify-between border-b border-border px-4">
              <span className="flex items-center gap-2 text-[12px] text-muted-foreground">
                <RiSearchLine className="size-4" />
                Szukaj lub przejdź…
                <span className="hidden rounded border border-border px-1 text-[10px] sm:inline">⌘K</span>
              </span>
              <span className="flex items-center gap-3 text-muted-foreground">
                <RiNotification3Line className="size-4" />
                <span className="flex size-6 items-center justify-center rounded-full bg-primary text-[9px] font-semibold text-primary-foreground">
                  JK
                </span>
              </span>
            </div>
            <div className="p-4 sm:p-6">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[15px] font-semibold">Faktury</p>
                <span className="rounded-full bg-primary px-3 py-1 text-[11px] font-semibold text-primary-foreground">
                  + Nowa faktura
                </span>
              </div>
              <div className="mt-3 flex gap-4 border-b border-border text-[12px]">
                <span className="-mb-px border-b-2 border-primary pb-2 font-medium">Wystawione</span>
                <span className="pb-2 text-muted-foreground">Cykliczne</span>
                <span className="pb-2 text-muted-foreground">Po terminie</span>
              </div>
              <div className="mt-3 overflow-hidden rounded-xl border border-border">
                <div className={cn(GRID, 'border-b border-border bg-muted/50 px-3 py-2 text-[11px] text-muted-foreground')}>
                  <span>Numer</span>
                  <span className="hidden sm:block">Nabywca</span>
                  <span className="hidden md:block">Data</span>
                  <span className="hidden text-right sm:block">Brutto</span>
                  <span className="justify-self-end">Status KSeF</span>
                </div>
                {/*
                  Miejsce na nową fakturę trzyma niewidoczny wiersz, a ona sama pojawia
                  się nad nim. Karta ma stałą wysokość, więc treść pod podglądem nie
                  skacze co pętlę (wcześniej wiersz rozwijał się od zera: na telefonie
                  56 px w dół i z powrotem co 8,5 s). Zanim faktura przyjdzie, w tym
                  miejscu jest zarys wiersza, a nie pusty pasek, który wyglądał jak usterka.
                */}
                <div className="relative overflow-hidden">
                  <div className="invisible">
                    <Row row={NEW_ROW} status="przyjeta" />
                  </div>
                  <AnimatePresence initial={false}>
                    {shown < 1 ? (
                      <motion.div
                        key="szkielet"
                        data-testid="podglad-szkielet"
                        className="absolute inset-0"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.3, ease: EASE_OUT }}
                      >
                        <SkeletonRow />
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                  <AnimatePresence initial={false}>
                    {shown >= 1 ? (
                      <motion.div
                        key={`nowa-${cycle}`}
                        className="absolute inset-0 bg-primary/[0.04]"
                        // Przy „ogranicz ruch” wiersz pojawia się tuż po hydratacji, bez wjazdu.
                        initial={reducedMotion ? false : { opacity: 0, y: -8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.45, ease: EASE_OUT }}
                      >
                        <Row row={NEW_ROW} status={newStatus} />
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </div>
                {ROWS.map((row) => (
                  <Row key={row.no} row={row} status="przyjeta" />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      <AnimatePresence>
        {shown >= 3 ? (
          <motion.div
            key={`upo-${cycle}`}
            className="absolute right-3 -bottom-5 flex items-center gap-2 rounded-xl bg-foreground px-3.5 py-2.5 text-[12px] font-medium text-background shadow-xl sm:right-8"
            initial={{ opacity: 0, y: 12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.35, ease: EASE_OUT }}
          >
            <span className="flex size-4 items-center justify-center rounded-full bg-emerald-500 text-white">
              <RiCheckLine className="size-3" />
            </span>
            FV/2026/11/004 przyjęta, UPO pobrane
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
