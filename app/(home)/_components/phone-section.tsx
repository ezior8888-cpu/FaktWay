'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { AnimatePresence, motion, useInView } from 'framer-motion';
import {
  RiAddLine,
  RiCameraLine,
  RiCheckDoubleLine,
  RiCheckLine,
  RiDashboardLine,
  RiFileList3Line,
  RiFingerprintLine,
  RiLoader4Line,
  RiMoreLine,
  RiNotification3Line,
  RiSearchLine,
  RiWallet3Line,
  type RemixiconComponentType,
} from '@remixicon/react';
import { BatteryFull, ScanFace, Signal, Wifi } from 'lucide-react';

import { cn } from '@/lib/utils';
import { usePrefersReducedMotion } from '@/hooks/use-media-query';

import { FaktWayLogo } from '@/components/brand/faktway-logo';
import { EASE_OUT, Reveal } from '@/components/site/motion';
import { BandGlow, ButtonLink, Container } from '@/components/site/ui';

type SceneId = 'faktura' | 'zdjecie' | 'naleznosci' | 'biometria';

/*
 * Telefon na stronie głównej (poprawka Bartosza 03.11.2026): funkcje po lewej,
 * makieta aplikacji pośrodku, opis po prawej. Na ekranie jest prawdziwy układ
 * panelu na telefonie: pasek z logo, dolna nawigacja z „Nowa” pośrodku.
 *
 * Każda scena ma pokrycie w kodzie (FaktWay 1.0, decyzja 4): wysyłka do KSeF
 * z UPO, wydatek ze zdjęcia (process-ocr), oznaczenie zapłaty i logowanie
 * biometrią (lib/auth/passkey). Firmy, numery i kwoty są zmyślone, NIP to
 * testowy 1234567890. Kwoty łączą sceny: zapłacona faktura znika z należności,
 * a pulpit po zalogowaniu pokazuje stan po obu zmianach.
 */
const SCENES: ReadonlyArray<{
  id: SceneId;
  tab: string;
  icon: RemixiconComponentType;
  title: string;
  text: string;
}> = [
  {
    id: 'faktura',
    tab: 'Faktura do KSeF',
    icon: RiFileList3Line,
    title: 'Faktura prosto do KSeF',
    text: 'Wystawiasz fakturę w telefonie, a FaktWay wysyła ją do KSeF i pobiera UPO.',
  },
  {
    id: 'zdjecie',
    tab: 'Koszt ze zdjęcia',
    icon: RiCameraLine,
    title: 'Zdjęcie prosto z aparatu',
    text: 'Przycisk „Dodaj wydatek” otwiera aparat, a dane z dokumentu odczytujemy sami.',
  },
  {
    id: 'naleznosci',
    tab: 'Należności',
    icon: RiCheckDoubleLine,
    title: 'Zapłacone jednym dotknięciem',
    text: 'Gdy klient zapłaci, oznaczasz fakturę jako zapłaconą i znika z listy należności.',
  },
  {
    id: 'biometria',
    tab: 'Biometria',
    icon: RiFingerprintLine,
    title: 'Logowanie biometrią',
    text: 'Odciskiem palca albo twarzą, jeśli Twój telefon to potrafi.',
  },
];

/*
 * Przebieg sceny (ms od zmiany funkcji): ekran się wypełnia, pojawia się
 * przycisk, palec go dotyka, a na końcu widać wynik. Dopóki nikt nie wybrał
 * funkcji, sceny zmieniają się same. Przy ograniczonym ruchu od razu wynik.
 */
const STEP_AT = [0, 700, 1700, 2800, 3700] as const;
const STEP_DONE = 4;
const ROTATE_AFTER_MS = 7800;

const FADE = { duration: 0.35, ease: EASE_OUT };
const show = (visible: boolean) => ({ opacity: visible ? 1 : 0, y: visible ? 0 : 6 });

const NAV: ReadonlyArray<{ label: string; icon: RemixiconComponentType }> = [
  { label: 'Pulpit', icon: RiDashboardLine },
  { label: 'Faktury', icon: RiFileList3Line },
  { label: 'Nowa', icon: RiAddLine },
  { label: 'Miesiąc', icon: RiWallet3Line },
  { label: 'Więcej', icon: RiMoreLine },
];

const ACTIVE_NAV: Record<SceneId, string> = {
  faktura: 'Nowa',
  zdjecie: 'Nowa',
  naleznosci: 'Faktury',
  biometria: 'Pulpit',
};

/** Dotknięcie palcem: fala w środku przycisku (rodzic ma `relative`). */
function Tap({ active }: { active: boolean }) {
  return (
    <AnimatePresence>
      {active ? (
        <motion.span
          className="pointer-events-none absolute inset-0 m-auto size-10 rounded-full bg-primary/30 ring-2 ring-primary/50"
          initial={{ scale: 0.3, opacity: 0 }}
          animate={{ scale: [0.3, 1, 1.6], opacity: [0, 1, 0] }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.75, ease: 'easeOut' }}
        />
      ) : null}
    </AnimatePresence>
  );
}

function ScreenTitle({ children }: { children: string }) {
  return <p className="text-[13px] font-semibold tracking-tight">{children}</p>;
}

/** Kafel z kwotą; nowa wartość wjeżdża od dołu, stara wyjeżdża do góry. */
function Tile({ label, value, tone, className }: { label: string; value: string; tone?: 'alert'; className?: string }) {
  return (
    <div className={cn('rounded-xl border border-border px-2.5 py-2', className)}>
      <p className="text-[9px] text-muted-foreground">{label}</p>
      <div className="relative h-4 overflow-hidden">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.p
            key={value}
            className={cn('text-[12px] leading-4 font-semibold', tone === 'alert' && 'text-destructive')}
            initial={{ y: 14, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -14, opacity: 0 }}
            transition={FADE}
          >
            {value}
          </motion.p>
        </AnimatePresence>
      </div>
    </div>
  );
}

/** Pole formularza wpisywane „na żywo”: tekst odsłania się od lewej. */
function TypedField({ label, value, typed, delay = 0 }: { label: string; value: string; typed: boolean; delay?: number }) {
  return (
    <div className="rounded-xl border border-border px-2.5 py-1.5">
      <p className="text-[9px] text-muted-foreground">{label}</p>
      <motion.p
        className="truncate text-[11px] leading-4 font-medium"
        initial={false}
        animate={{ clipPath: typed ? 'inset(0 0% 0 0)' : 'inset(0 100% 0 0)' }}
        transition={{ duration: typed ? 0.55 : 0, delay: typed ? delay : 0, ease: 'linear' }}
      >
        {value}
      </motion.p>
    </div>
  );
}

function InvoiceScene({ step }: { step: number }) {
  const sending = step === 3;
  const done = step >= STEP_DONE;
  return (
    <div className="flex h-full flex-col gap-2">
      <ScreenTitle>Nowa faktura</ScreenTitle>
      <TypedField label="Nabywca" value="Przykładowa Firma sp. z o.o." typed={step >= 1} />
      <TypedField label="NIP" value="1234567890" typed={step >= 1} delay={0.45} />
      <motion.div className="rounded-xl bg-muted p-2.5" initial={false} animate={show(step >= 2)} transition={FADE}>
        <div className="flex justify-between text-[11px] font-medium">
          <span>Usługa projektowa</span>
          <span>1 230,00 zł</span>
        </div>
        <p className="mt-0.5 text-[9px] text-muted-foreground">1 szt. · VAT 23%</p>
        <div className="mt-2 flex justify-between border-t border-border pt-2 text-[11px]">
          <span className="text-muted-foreground">Razem brutto</span>
          <span className="font-semibold">1 512,90 zł</span>
        </div>
      </motion.div>
      <div className="mt-auto">
        <AnimatePresence mode="wait" initial={false}>
          {done ? (
            <motion.div
              key="przyjeta"
              className="rounded-xl bg-primary/10 p-3"
              initial={{ opacity: 0, y: 10, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={FADE}
            >
              <p className="flex items-center gap-1.5 text-[12px] font-semibold text-primary">
                <span className="flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <RiCheckLine className="size-3" />
                </span>
                Przyjęta w KSeF
              </p>
              <p className="mt-1 text-[9px] text-muted-foreground">FV/2026/11/004 · UPO pobrane</p>
            </motion.div>
          ) : (
            <motion.div
              key="wyslij"
              className="relative"
              initial={false}
              animate={show(step >= 2)}
              exit={{ opacity: 0, y: -6 }}
              transition={FADE}
            >
              <motion.span
                className="flex h-9 items-center justify-center gap-1.5 rounded-full bg-primary text-[12px] font-semibold text-primary-foreground"
                animate={{ scale: sending ? 0.97 : 1 }}
                transition={{ duration: 0.2 }}
              >
                {sending ? <RiLoader4Line className="size-3.5 animate-spin" /> : null}
                {sending ? 'Wysyłanie do KSeF…' : 'Wyślij do KSeF'}
              </motion.span>
              <Tap active={sending} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function ExpenseScene({ step }: { step: number }) {
  const reading = step === 3;
  const done = step >= STEP_DONE;
  return (
    <div className="flex h-full flex-col gap-2.5">
      <ScreenTitle>Dodaj wydatek</ScreenTitle>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl bg-neutral-900">
        <div className="absolute inset-x-9 top-6 bottom-9 -rotate-3 rounded-[3px] bg-white px-3 py-3 font-mono text-[7.5px] leading-[1.7] text-neutral-600 shadow-xl">
          <p className="text-center text-[8.5px] font-semibold tracking-wide text-neutral-900">STACJA PALIW</p>
          <p className="text-center">ul. Przykładowa 1</p>
          <div className="my-1.5 border-t border-dashed border-neutral-300" />
          <p className="flex justify-between">
            <span>Paliwo</span>
            <span>245,60</span>
          </p>
          <div className="my-1 h-1 w-3/4 rounded-full bg-neutral-200" />
          <div className="my-1 h-1 w-1/2 rounded-full bg-neutral-200" />
          <div className="my-1.5 border-t border-dashed border-neutral-300" />
          <p className="flex justify-between font-semibold text-neutral-900">
            <span>SUMA PLN</span>
            <span>245,60</span>
          </p>
        </div>
        {/* Rogi kadru. */}
        <span className="absolute top-3 left-3 size-5 rounded-tl-lg border-t-2 border-l-2 border-white/90" />
        <span className="absolute top-3 right-3 size-5 rounded-tr-lg border-t-2 border-r-2 border-white/90" />
        <span className="absolute bottom-3 left-3 size-5 rounded-bl-lg border-b-2 border-l-2 border-white/90" />
        <span className="absolute right-3 bottom-3 size-5 rounded-br-lg border-r-2 border-b-2 border-white/90" />
        {step >= 1 && step < 3 ? (
          <motion.span
            className="absolute inset-x-5 h-0.5 rounded-full bg-primary shadow-[0_0_14px_3px] shadow-primary/70"
            initial={{ top: '14%' }}
            animate={{ top: ['14%', '84%', '14%'] }}
            transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
          />
        ) : null}
        <AnimatePresence>
          {reading ? (
            <motion.span
              key="blysk"
              className="absolute inset-0 bg-white"
              initial={{ opacity: 0.85 }}
              animate={{ opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.45 }}
            />
          ) : null}
        </AnimatePresence>
        <AnimatePresence>
          {reading ? (
            <motion.span
              key="odczyt"
              className="absolute inset-x-0 top-3 mx-auto flex w-fit items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-[9px] font-medium text-white"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={FADE}
            >
              <RiLoader4Line className="size-3 animate-spin" />
              Odczytujemy dane…
            </motion.span>
          ) : null}
        </AnimatePresence>
        <AnimatePresence>
          {done ? (
            <motion.div
              key="wynik"
              className="absolute inset-x-2.5 bottom-2.5 rounded-xl bg-background p-2.5 text-foreground shadow-2xl"
              initial={{ opacity: 0, y: 28 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, ease: EASE_OUT }}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-[11px] font-semibold">Stacja paliw</p>
                  <p className="text-[9px] text-muted-foreground">03.11.2026</p>
                </div>
                <p className="text-[12px] font-semibold">245,60 zł</p>
              </div>
              <p className="mt-1.5 flex items-center gap-1 text-[9px] font-medium text-primary">
                <RiCheckLine className="size-3" />
                Dodano do kosztów
              </p>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
      <div className="relative mx-auto flex size-11 shrink-0 items-center justify-center rounded-full ring-2 ring-border">
        <motion.span
          className="size-8 rounded-full bg-primary"
          animate={{ scale: step === 2 ? [1, 0.82, 1] : 1 }}
          transition={{ duration: 0.35 }}
        />
        <Tap active={step === 2} />
      </div>
    </div>
  );
}

const RECEIVABLES = [
  { no: 'FV/2026/10/014', buyer: 'Przykładowa Firma sp. z o.o.', amount: '1 512,90 zł', note: '7 dni po terminie' },
  { no: 'FV/2026/11/002', buyer: 'Pracownia Wzór', amount: '2 460,00 zł', note: 'termin 10.11' },
  { no: 'FV/2026/11/003', buyer: 'Sklep Próbny', amount: '890,50 zł', note: 'termin 17.11' },
] as const;

function ReceivablesScene({ step }: { step: number }) {
  const done = step >= STEP_DONE;
  const rows = done ? RECEIVABLES.slice(1) : RECEIVABLES;
  return (
    <div className="flex h-full flex-col gap-2">
      <ScreenTitle>Należności</ScreenTitle>
      <div className="grid grid-cols-2 gap-2">
        <Tile label="Do zapłaty" value={done ? '3 350,50 zł' : '4 863,40 zł'} />
        <Tile label="Po terminie" value={done ? '0' : '1'} tone={done ? undefined : 'alert'} />
      </div>
      <ul className="flex flex-col gap-1.5">
        <AnimatePresence initial={false}>
          {rows.map((row) => {
            const overdue = row.no === RECEIVABLES[0].no;
            return (
              <motion.li
                key={row.no}
                layout
                exit={{ opacity: 0, height: 0, x: 40 }}
                transition={{ duration: 0.4, ease: EASE_OUT }}
              >
                <div
                  className={cn(
                    'relative rounded-xl border border-border px-2.5 py-2 transition-shadow duration-300',
                    overdue && step >= 1 && 'ring-2 ring-primary/40',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-[11px] font-medium">{row.buyer}</p>
                    <p className="shrink-0 text-[11px] font-semibold">{row.amount}</p>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-2 text-[9px]">
                    <span className="text-muted-foreground">{row.no}</span>
                    <span className={overdue ? 'font-medium text-destructive' : 'text-muted-foreground'}>{row.note}</span>
                  </div>
                  {overdue ? <Tap active={step === 1} /> : null}
                </div>
                {overdue ? (
                  <motion.div
                    className="overflow-hidden"
                    initial={false}
                    animate={{ height: step >= 2 ? 'auto' : 0, opacity: step >= 2 ? 1 : 0 }}
                    transition={FADE}
                  >
                    <div className="relative pt-1.5">
                      <span className="flex h-8 items-center justify-center gap-1.5 rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                        <RiCheckLine className="size-3.5" />
                        Oznacz jako zapłaconą
                      </span>
                      <Tap active={step === 3} />
                    </div>
                  </motion.div>
                ) : null}
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
      <AnimatePresence>
        {done ? (
          <motion.p
            key="zaplacona"
            className="mx-auto mt-auto flex items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-[10px] font-medium text-background"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...FADE, delay: 0.2 }}
          >
            <RiCheckLine className="size-3" />
            Faktura zapłacona
          </motion.p>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** Pulpit po zalogowaniu: stan po scenach z fakturą, wydatkiem i zapłatą. */
function DashboardScene() {
  return (
    <div className="flex h-full flex-col gap-2">
      <ScreenTitle>Dzień dobry</ScreenTitle>
      <div className="grid grid-cols-2 gap-2">
        <Tile label="Do zapłaty" value="3 350,50 zł" />
        <Tile label="Po terminie" value="0" />
        <Tile label="Koszty w listopadzie" value="245,60 zł" className="col-span-2" />
      </div>
      <div className="rounded-xl border border-border px-2.5 py-2">
        <p className="text-[9px] text-muted-foreground">Ostatnio w KSeF</p>
        <div className="mt-1 flex items-center justify-between text-[11px]">
          <span className="font-medium">FV/2026/11/004</span>
          <span className="flex items-center gap-1 text-[9px] font-medium text-primary">
            <RiCheckLine className="size-3" />
            Przyjęta
          </span>
        </div>
      </div>
    </div>
  );
}

/** Ekran logowania nad pulpitem: przycisk, okno systemu z biometrią, potwierdzenie. */
function LoginOverlay({ step }: { step: number }) {
  return (
    <motion.div
      className="absolute inset-0 z-10 flex flex-col items-center bg-background px-6 pt-24"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.05 }}
      transition={{ duration: 0.4, ease: EASE_OUT }}
    >
      <FaktWayLogo className="h-6" />
      <p className="mt-8 text-[13px] font-semibold">Zaloguj się</p>
      <div className="mt-3 h-8 w-full rounded-lg border border-border px-2.5 text-[10px] leading-8 text-muted-foreground">
        Adres e-mail
      </div>
      <div className="relative mt-2 w-full">
        <span className="flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-border text-[11px] font-medium">
          <RiFingerprintLine className="size-4" />
          Zaloguj biometrią
        </span>
        <Tap active={step === 1} />
      </div>
      <AnimatePresence>
        {step >= 2 ? (
          <motion.div
            key="system"
            className="absolute inset-0 flex items-center justify-center bg-black/30"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
          >
            <motion.div
              className="flex size-28 items-center justify-center rounded-[1.75rem] bg-background shadow-2xl"
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.35, ease: EASE_OUT }}
            >
              <AnimatePresence mode="wait" initial={false}>
                {step >= 3 ? (
                  <motion.span
                    key="ok"
                    className="flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground"
                    initial={{ scale: 0.4, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ type: 'spring', stiffness: 420, damping: 22 }}
                  >
                    <RiCheckLine className="size-8" />
                  </motion.span>
                ) : (
                  <motion.span
                    key="skan"
                    className="text-primary"
                    animate={{ scale: [1, 1.08, 1], opacity: [0.75, 1, 0.75] }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    transition={{ duration: 0.9, repeat: Infinity, ease: 'easeInOut' }}
                  >
                    <ScanFace className="size-14" strokeWidth={1.4} />
                  </motion.span>
                )}
              </AnimatePresence>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}

function SceneBody({ id, step }: { id: SceneId; step: number }) {
  if (id === 'faktura') return <InvoiceScene step={step} />;
  if (id === 'zdjecie') return <ExpenseScene step={step} />;
  if (id === 'naleznosci') return <ReceivablesScene step={step} />;
  return <DashboardScene />;
}

/** Makieta telefonu. Ilustracja: opis tej samej funkcji stoi obok, w panelu zakładki. */
function PhoneMockup({ scene, step }: { scene: SceneId; step: number }) {
  return (
    <div aria-hidden className="relative isolate mx-auto w-[260px] select-none sm:w-[288px]">
      <div className="absolute inset-x-4 top-16 bottom-16 -z-10 rounded-full bg-primary-foreground/25 blur-3xl" />
      {/* Przyciski z boku obudowy. */}
      <span className="absolute top-[17%] -left-[3px] h-7 w-[3px] rounded-l bg-neutral-700" />
      <span className="absolute top-[25%] -left-[3px] h-11 w-[3px] rounded-l bg-neutral-700" />
      <span className="absolute top-[33%] -left-[3px] h-11 w-[3px] rounded-l bg-neutral-700" />
      <span className="absolute top-[27%] -right-[3px] h-16 w-[3px] rounded-r bg-neutral-700" />
      <div className="rounded-[2.9rem] bg-neutral-900 p-[9px] shadow-[0_40px_80px_-24px_rgb(0_0_0/0.6)] ring-1 ring-white/15">
        <div className="relative flex aspect-[9/19] flex-col overflow-hidden rounded-[2.35rem] bg-background text-left text-foreground">
          <div className="relative z-20 flex h-10 shrink-0 items-center justify-between px-6 pt-1 text-[11px] font-semibold">
            <span>9:41</span>
            <span className="absolute inset-x-0 top-2.5 mx-auto h-[22px] w-[80px] rounded-full bg-neutral-950" />
            <span className="flex items-center gap-1">
              <Signal className="size-3" strokeWidth={2.5} />
              <Wifi className="size-3" strokeWidth={2.5} />
              <BatteryFull className="size-4" strokeWidth={2} />
            </span>
          </div>

          <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3.5">
            <FaktWayLogo className="h-[15px]" />
            <span className="flex items-center gap-2.5 text-muted-foreground">
              <RiSearchLine className="size-4" />
              <RiNotification3Line className="size-4" />
              <span className="flex size-6 items-center justify-center rounded-full bg-primary text-[9px] font-semibold text-primary-foreground">
                JK
              </span>
            </span>
          </div>

          <div className="relative min-h-0 flex-1 overflow-hidden px-3.5 py-3">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={scene}
                className="h-full"
                initial={{ opacity: 0, x: 28 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -28 }}
                transition={{ duration: 0.32, ease: EASE_OUT }}
              >
                <SceneBody id={scene} step={step} />
              </motion.div>
            </AnimatePresence>
          </div>

          <div className="grid h-12 shrink-0 grid-cols-5 border-t border-border px-1 text-[8px] font-medium text-muted-foreground">
            {NAV.map(({ label, icon: Icon }) => {
              const active = ACTIVE_NAV[scene] === label;
              if (label === 'Nowa') {
                return (
                  <span key={label} className="flex items-center justify-center">
                    <motion.span
                      className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md shadow-primary/30"
                      animate={{ scale: active ? 1.08 : 1 }}
                      transition={{ duration: 0.3 }}
                    >
                      <Icon className="size-4.5" />
                    </motion.span>
                  </span>
                );
              }
              return (
                <span
                  key={label}
                  className={cn(
                    'flex flex-col items-center justify-center gap-0.5 transition-colors duration-300',
                    active && 'text-primary',
                  )}
                >
                  <Icon className="size-4" />
                  {label}
                </span>
              );
            })}
          </div>
          <div className="flex h-5 shrink-0 justify-center pt-1.5">
            <span className="h-1 w-24 rounded-full bg-foreground/80" />
          </div>

          <AnimatePresence>
            {scene === 'biometria' && step < STEP_DONE ? <LoginOverlay key="logowanie" step={step} /> : null}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

// Telefon opisany tak, jak działa: przeglądarka i ekran główny (decyzja 4).
export function Phone() {
  const [active, setActive] = useState(0);
  const [step, setStep] = useState(0);
  const [autoplay, setAutoplay] = useState(true);
  // Sceny liczą się od chwili, gdy widać telefon, a nie sam nagłówek pasa
  // (na telefonie makieta jest ekran niżej).
  const phoneRef = useRef<HTMLDivElement>(null);
  const inView = useInView(phoneRef, { amount: 0.5 });
  const reducedMotion = usePrefersReducedMotion();
  const baseId = useId();
  const tabId = (i: number) => `${baseId}-tab-${i}`;
  const panelId = `${baseId}-panel`;

  // Kroki tylko rosną, więc powrót do telefonu w połowie sceny jej nie cofa.
  useEffect(() => {
    if (reducedMotion || !inView) return;
    const timers = STEP_AT.slice(1).map((ms, i) =>
      setTimeout(() => setStep((current) => Math.max(current, i + 1)), ms),
    );
    if (autoplay) {
      timers.push(
        setTimeout(() => {
          setActive((current) => (current + 1) % SCENES.length);
          setStep(0);
        }, ROTATE_AFTER_MS),
      );
    }
    return () => timers.forEach(clearTimeout);
  }, [active, inView, autoplay, reducedMotion]);

  const select = (i: number) => {
    setAutoplay(false);
    setActive(i);
    setStep(0);
  };

  // Strzałki przesuwają wybór jak w zwykłych zakładkach (WAI-ARIA Tabs).
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const move = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    if (!move) return;
    event.preventDefault();
    const next = (active + move + SCENES.length) % SCENES.length;
    select(next);
    document.getElementById(tabId(next))?.focus();
  };

  const scene = SCENES[active];
  const shownStep = reducedMotion ? STEP_DONE : step;
  const showProgress = autoplay && inView && !reducedMotion;

  return (
    <section
      id="telefon"
      aria-labelledby="telefon-title"
      className="relative overflow-hidden bg-primary py-20 text-primary-foreground sm:py-28"
    >
      <BandGlow />
      <Container className="relative">
        <Reveal className="mx-auto max-w-3xl text-center">
          <h2 id="telefon-title" className="text-3xl font-semibold tracking-tight text-balance sm:text-5xl">
            FaktWay także w telefonie
          </h2>
          <p className="mt-5 text-lg text-pretty text-primary-foreground">
            Działa w przeglądarce telefonu. Możesz dodać go do ekranu głównego i otwierać jak zwykły program.
          </p>
        </Reveal>

        <Reveal
          delay={0.1}
          y={32}
          className="mt-12 grid items-center gap-10 lg:mt-20 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:gap-14"
        >
          <div
            role="tablist"
            aria-label="Funkcje w telefonie"
            aria-orientation="vertical"
            onKeyDown={onKeyDown}
            className="flex flex-wrap justify-center gap-2 lg:flex-col lg:flex-nowrap lg:justify-self-end"
          >
            {SCENES.map((item, i) => {
              const selected = i === active;
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  id={tabId(i)}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={panelId}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => select(i)}
                  className={cn(
                    'relative flex shrink-0 items-center gap-2 overflow-hidden rounded-full px-4 py-2 text-sm font-semibold transition-colors duration-200 lg:w-64 lg:gap-3 lg:rounded-2xl lg:px-5 lg:py-4 lg:text-base',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-foreground',
                    selected
                      ? 'bg-primary-foreground text-primary shadow-lg shadow-black/10'
                      : 'text-primary-foreground ring-1 ring-primary-foreground/30 hover:bg-primary-foreground/10 lg:ring-0',
                  )}
                >
                  <Icon aria-hidden className="size-4 shrink-0 lg:size-5" />
                  {item.tab}
                  {selected && showProgress ? (
                    // Pasek do następnej sceny; znika po pierwszym wyborze.
                    <motion.span
                      key={`${active}-${String(inView)}`}
                      aria-hidden
                      className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-primary/40"
                      initial={{ scaleX: 0 }}
                      animate={{ scaleX: 1 }}
                      transition={{ duration: ROTATE_AFTER_MS / 1000, ease: 'linear' }}
                    />
                  ) : null}
                </button>
              );
            })}
          </div>

          <motion.div
            ref={phoneRef}
            animate={reducedMotion ? undefined : { y: [0, -10, 0] }}
            transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
          >
            <PhoneMockup scene={scene.id} step={shownStep} />
          </motion.div>

          <div
            id={panelId}
            role="tabpanel"
            aria-labelledby={tabId(active)}
            className="mx-auto max-w-sm text-center lg:mx-0 lg:text-left"
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={scene.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
              >
                <h3 className="text-2xl font-semibold tracking-tight">{scene.title}</h3>
                <p className="mt-3 text-lg text-pretty text-primary-foreground">{scene.text}</p>
              </motion.div>
            </AnimatePresence>
            <ButtonLink href="/register" variant="inverse" className="mt-8">
              Wypróbuj za darmo
            </ButtonLink>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}
