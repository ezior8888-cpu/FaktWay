"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { MotionConfig, motion } from "framer-motion";

import {
  RiLogoutBoxRLine,
  RiQuestionLine,
  type RemixiconComponentType,
} from "@remixicon/react";

import { signOut } from "@/app/(auth)/login/actions";
import { LinkPendingMark } from "@/components/navigation/link-pending-mark";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { OTWORZ_POMOC } from "@/lib/support/open-support-event";
import {
  dashboardMobileTabs,
  dashboardSettingsNavItem,
  getDashboardMoreSections,
  isActiveNavPath,
  type DashboardMobileTab,
} from "@/lib/dashboard-nav-config";
import { cn } from "@/lib/utils";

/** Ile najdłużej „Więcej” pokazuje oczekiwanie na stronę wybraną w arkuszu. */
const MORE_PENDING_MAX_MS = 10_000;

/** Sprężyna plusa: krótka, z wyraźnym odbiciem — jak przycisk w aplikacji, nie strona. */
const PLUS_SPRING = { type: "spring" as const, stiffness: 520, damping: 26 };

/**
 * Dolna nawigacja telefonu — pasek z sierpniowej makiety.
 *
 * DLACZEGO W OGÓLE, SKORO BYŁ HAMBURGER. Panel dostał się na telefon dopiero
 * we wrześniu 2026 (zdjęcie BUG-008), a jedyną nawigacją była szuflada z lewej
 * spod hamburgera. Na telefonie oznacza to dwa dotknięcia do każdej strony
 * i kciuk w górnym lewym rogu — najdalszym miejscu ekranu. Pasek na dole to
 * jedno dotknięcie, w zasięgu kciuka.
 *
 * PRÓG `lg`, nie `md`: sidebar znika dokładnie tam (`sidebar.tsx`), więc
 * między `md` a `lg` nie ma okna, w którym nie byłoby żadnej nawigacji.
 * Tablet dostaje ten sam pasek zamiast hamburgera — jeden wzorzec zamiast
 * dwóch na tej samej szerokości.
 *
 * PODŚWIETLENIE Z NAWIGACJI, NIE Z DOTKNIĘCIA (poprawka Bartosza 25.10.2026:
 * „podświetla się i nic się nie dzieje, dopiero za drugim razem”). Dawniej
 * `pointerdown` od razu podświetlał slot i gasił je dopiero zmiana adresu.
 * Gdy dotyk nie kończył się kliknięciem (palec się przesunął, iOS przejął
 * gest), slot zostawał zapalony bez żadnej nawigacji. Teraz slot zapala
 * `LinkPendingMark` (`useLinkStatus`), czyli tylko trwająca nawigacja Nexta,
 * a pasek postępu u góry paska mówi, że strona jest w drodze
 * (`.ff-bottom-nav` w `globals.css`).
 */
export function BottomNav() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  // Pozycja wybrana w arkuszu „Więcej”. Arkusz zamyka się od razu, więc jego
  // link znika i nie zgłosi oczekiwania — robi to za niego slot „Więcej”.
  const [morePending, setMorePending] = useState<string | null>(null);

  // Nowa trasa: arkusz zamknięty, oczekiwanie skończone. Stan dostosowany
  // w renderze (wzorzec Reacta „poprzednia wartość”), bez efektu.
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setMoreOpen(false);
    setMorePending(null);
  }

  // Nieudana nawigacja nie może zostawić „Więcej” w oczekiwaniu na zawsze.
  useEffect(() => {
    if (morePending === null) return;
    const timer = setTimeout(() => setMorePending(null), MORE_PENDING_MAX_MS);
    return () => clearTimeout(timer);
  }, [morePending]);

  const moreSections = useMemo(() => getDashboardMoreSections(), []);

  /**
   * „Więcej" jest aktywne, gdy jesteśmy na trasie, która nie ma własnego
   * slotu — inaczej wejście w Wydatki czy KPiR gasi cały pasek i klient nie
   * widzi, gdzie jest.
   */
  const moreActive =
    moreOpen ||
    morePending !== null ||
    !dashboardMobileTabs.some(
      (tab) => tab.href !== null && isActiveNavPath(pathname, tab.href),
    );

  const chooseFromMore = (href: string) => {
    setMoreOpen(false);
    if (!isActiveNavPath(pathname, href)) setMorePending(href);
  };

  return (
    <>
      <nav
        aria-label="Nawigacja główna"
        className="ff-bottom-nav fixed inset-x-0 bottom-0 z-40 flex items-stretch lg:hidden"
      >
        {dashboardMobileTabs.map((tab) => {
          if (tab.emphasis && tab.href !== null) {
            return (
              <PlusSlot
                key={tab.label}
                tab={tab}
                href={tab.href}
                active={isActiveNavPath(pathname, tab.href)}
              />
            );
          }
          if (tab.href === null) {
            return (
              <button
                key={tab.label}
                type="button"
                onClick={() => setMoreOpen(true)}
                aria-expanded={moreOpen}
                className={cn(
                  SLOT_CLASS,
                  moreActive ? SLOT_ACTIVE : SLOT_IDLE,
                  "pb-[var(--ff-safe-b)]",
                )}
              >
                {morePending !== null ? <span data-link-pending="" hidden /> : null}
                <tab.icon aria-hidden className="size-5" />
                <span>{tab.label}</span>
              </button>
            );
          }
          const active = isActiveNavPath(pathname, tab.href);
          return (
            <Link
              key={tab.label}
              href={tab.href}
              prefetch
              aria-current={active ? "page" : undefined}
              className={cn(
                SLOT_CLASS,
                active ? SLOT_ACTIVE : SLOT_IDLE,
                "pb-[var(--ff-safe-b)]",
              )}
            >
              <LinkPendingMark />
              <tab.icon aria-hidden className="size-5" />
              <span>{tab.label}</span>
            </Link>
          );
        })}
      </nav>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent
          side="bottom"
          className="ff-dashboard max-h-[85dvh] overflow-y-auto rounded-t-2xl border-[var(--ff-border)] pb-[calc(1rem+var(--ff-safe-b))] text-[var(--ff-on-surface)]"
        >
          <SheetTitle className="text-left text-base font-semibold text-[var(--ff-text-strong)]">
            Więcej
          </SheetTitle>

          {moreSections.map((section) => (
            <div key={section.title} className="min-w-0">
              <p className="px-1 pb-1.5 pt-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--ff-text-faint)]">
                {section.title}
              </p>
              <div className="flex flex-col">
                {section.items.map((item) => (
                  <MoreRow
                    key={item.href}
                    href={item.href}
                    label={item.label}
                    icon={item.icon}
                    prefetch={item.prefetch !== false}
                    active={isActiveNavPath(pathname, item.href)}
                    onChoose={chooseFromMore}
                  />
                ))}
              </div>
            </div>
          ))}

          <div className="mt-1 min-w-0 border-t border-[var(--ff-border)] pt-2">
            <MoreRow
              href={dashboardSettingsNavItem.href}
              label={dashboardSettingsNavItem.label}
              icon={dashboardSettingsNavItem.icon}
              active={isActiveNavPath(pathname, dashboardSettingsNavItem.href)}
              onChoose={chooseFromMore}
            />

            {/* Pomoc jest tu, bo na telefonie pływający bąbelek jest ukryty —
                siadał na przycisku „Zapisz” w przyklejonym pasku formularzy. */}
            <button
              type="button"
              onClick={() => {
                setMoreOpen(false);
                window.dispatchEvent(new Event(OTWORZ_POMOC));
              }}
              className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-[var(--ff-text)] transition-colors hover:bg-[var(--ff-row-hover)]"
            >
              <RiQuestionLine aria-hidden className="size-5 shrink-0" />
              Pomoc
            </button>
          </div>

          {/* Ustawienia i Wyloguj są też w menu profilu paska górnego (od
              21.10.2026 pasek 1:1 z Finory, widoczny na każdej szerokości).
              Tu zostają celowo: arkusz „Więcej” to nawigacja telefonu, a sama
              Finora też dubluje zębatkę i „Settings” w menu profilu.
              Przełącznika motywu tu NIE MA: księżyc stoi w pasku górnym. */}
          <form
            action={signOut}
            className="border-t border-[var(--ff-border)] pt-2"
          >
            <button
              type="submit"
              className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-[var(--ff-text-muted)] transition-colors hover:bg-[var(--ff-row-hover)] hover:text-[var(--ff-text)]"
            >
              <RiLogoutBoxRLine aria-hidden className="size-5 shrink-0" />
              Wyloguj
            </button>
          </form>
        </SheetContent>
      </Sheet>
    </>
  );
}

// 44 px to minimalny cel dotykowy z wytycznych Apple i Google; slot ma pełną
// wysokość paska, więc trafienie jest łatwiejsze niż w samą ikonę.
// `active:scale-95`: dotyk widać od razu, zanim ruszy nawigacja.
const SLOT_CLASS =
  "flex flex-1 select-none flex-col items-center justify-center gap-1 pt-2 text-[11px] font-medium leading-none transition-[color,transform] duration-150 active:scale-95";
const SLOT_ACTIVE = "text-[var(--ff-accent)]";
const SLOT_IDLE = "text-[var(--ff-text-muted)]";

/**
 * Plus dolnego paska: link do „Nowa faktura” (tam też kafel „Wydatek” ze
 * zdjęcia, poprawka Bartosza 25.10.2026 — wysuwane menu nad plusem odpadło).
 *
 * Animacja zamiast „płaskiego przejścia”: koło ugina się pod palcem i obraca
 * plus o ćwierć obrotu, a po puszczeniu wraca na sprężynie z odbiciem
 * (`whileTap`). Dopóki strona kreatora jest w drodze, koło pulsuje
 * (`[data-ff-plus]` w `globals.css`). `MotionConfig reducedMotion="user"`:
 * przy „ogranicz ruch” bez obrotu i odbicia.
 *
 * Koło stoi w pasku na miejscu napisu (poprawka 21.10.2026), napis zostaje
 * dla czytników ekranu (`sr-only`).
 */
function PlusSlot({
  tab,
  href,
  active,
}: {
  tab: DashboardMobileTab;
  href: string;
  active: boolean;
}) {
  return (
    <MotionConfig reducedMotion="user">
      <Link
        href={href}
        prefetch
        aria-current={active ? "page" : undefined}
        // `pb-[var(--ff-safe-b)]` jak w pozostałych slotach: bez niego na
        // iPhonie z paskiem domowym koło zjeżdżałoby w strefę paska.
        // `active:scale-100`: ugięcie robi koło, nie cały slot.
        className={cn(
          SLOT_CLASS,
          "pb-[var(--ff-safe-b)] text-[var(--ff-accent)] active:scale-100",
        )}
      >
        <LinkPendingMark />
        <motion.span
          aria-hidden
          data-ff-plus=""
          whileTap={{ scale: 0.8, rotate: 90 }}
          transition={PLUS_SPRING}
          className="flex size-11 items-center justify-center rounded-full bg-[var(--ff-primary)] text-[var(--ff-on-primary)] shadow-md shadow-primary/30"
        >
          <tab.icon aria-hidden className="size-6" />
        </motion.span>
        <span className="sr-only">{tab.label}</span>
      </Link>
    </MotionConfig>
  );
}

function MoreRow({
  href,
  label,
  icon: Icon,
  active,
  prefetch = true,
  onChoose,
}: {
  href: string;
  label: string;
  icon: RemixiconComponentType;
  /** `false` dla ciężkich stron (`/analizy/*`, plan Finora §4). */
  prefetch?: boolean;
  active: boolean;
  /**
   * Wybór pozycji: arkusz zamyka się od razu. Dawniej czekał otwarty na
   * przyjście strony, więc wyglądało, że nic się nie stało, i klient
   * dotykał drugi raz.
   */
  onChoose: (href: string) => void;
}) {
  return (
    <Link
      href={href}
      prefetch={prefetch}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        onChoose(href);
      }}
      className={cn(
        "flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors",
        active
          ? "ff-sidebar-active text-[var(--ff-accent)]"
          : "text-[var(--ff-text)] hover:bg-[var(--ff-row-hover)]",
      )}
    >
      <Icon
        aria-hidden
        className={cn("size-5 shrink-0", active && "text-[var(--ff-accent)]")}
      />
      {label}
    </Link>
  );
}
