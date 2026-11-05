'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RiFileList3Line, RiSearchLine, RiUserLine } from '@remixicon/react';

import {
  searchCommandPaletteAction,
  type CommandSearchContractor,
  type CommandSearchInvoice,
} from '@/app/actions/command-search';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { Kbd } from '@/components/ui/kbd';
import {
  buildPaletteNavEntries,
  normalizeSearchQuery,
  PALETTE_ACTIONS_GROUP,
  PALETTE_NAV_GROUP,
} from '@/lib/command-palette';

const DEBOUNCE_MS = 250;

/*
 * Na telefonie lupa stoi po prawej stronie paska, a miejsce przy menu zajmuje
 * logo (poprawka Bartosza 03.11.2026). Paleta zostaje jedna, z jednym skrótem
 * ⌘K, więc przycisk z drugiej strony paska otwiera ją zdarzeniem.
 */
const OPEN_EVENT = 'ff:command-menu-open';

/** Przycisk z lupą na telefonie (`AppHeader`): otwiera tę samą paletę co ⌘K. */
export function CommandMenuPhoneTrigger() {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="sm:hidden"
      aria-label="Szukaj"
      onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))}
    >
      <RiSearchLine aria-hidden />
    </Button>
  );
}

type RemoteState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; invoices: CommandSearchInvoice[]; contractors: CommandSearchContractor[] };

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement)
  );
}

export function CommandMenu() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [remote, setRemote] = useState<RemoteState>({ status: 'idle' });
  const requestId = useRef(0);

  const entries = useMemo(() => buildPaletteNavEntries(), []);
  const navEntries = entries.filter((e) => e.group === PALETTE_NAV_GROUP);
  const actionEntries = entries.filter((e) => e.group === PALETTE_ACTIONS_GROUP);

  // Jedna ścieżka otwierania/zamykania — zamknięcie (skrót, Esc, wybór pozycji)
  // zawsze czyści frazę i wyniki zdalne.
  const onOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) {
      setSearch('');
      setRemote({ status: 'idle' });
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isK = e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey);
      const isSlash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey;
      if (!isK && !isSlash) return;
      if (isSlash && isTypingTarget(e.target)) return;
      e.preventDefault();
      onOpenChange(!open);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onOpenChange]);

  useEffect(() => {
    const onOpenRequest = () => onOpenChange(true);
    window.addEventListener(OPEN_EVENT, onOpenRequest);
    return () => window.removeEventListener(OPEN_EVENT, onOpenRequest);
  }, [onOpenChange]);

  // Wyszukiwanie zdalne: debounce 250 ms + ochrona przed spóźnioną odpowiedzią.
  useEffect(() => {
    const id = ++requestId.current;
    const q = open ? normalizeSearchQuery(search) : null;
    if (!q) return;
    const timer = window.setTimeout(() => {
      setRemote({ status: 'loading' });
      searchCommandPaletteAction(q)
        .then((res) => {
          if (id !== requestId.current) return;
          setRemote(
            res.success
              ? { status: 'done', invoices: res.invoices, contractors: res.contractors }
              : { status: 'error', message: res.error },
          );
        })
        .catch(() => {
          if (id !== requestId.current) return;
          setRemote({ status: 'error', message: 'Nie udało się wyszukać. Spróbuj ponownie.' });
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search, open]);

  const onSearchChange = (value: string) => {
    setSearch(value);
    if (!normalizeSearchQuery(value)) setRemote({ status: 'idle' });
  };

  const go = (href: string) => {
    router.push(href);
    onOpenChange(false);
  };

  const hasQuery = normalizeSearchQuery(search) !== null;
  const invoices = remote.status === 'done' ? remote.invoices : [];
  const contractors = remote.status === 'done' ? remote.contractors : [];

  return (
    <>
      <Button
        variant="ghost"
        className="hidden gap-2 px-2.5 font-normal sm:inline-flex"
        onClick={() => setOpen(true)}
      >
        <RiSearchLine aria-hidden />
        <span className="text-muted-foreground text-sm">Szukaj lub przejdź…</span>
        <Kbd>⌘K</Kbd>
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={onOpenChange}
        title="Szukaj lub przejdź"
        description="Wyszukaj fakturę, kontrahenta albo przejdź do ekranu aplikacji."
      >
        <Command label="Szukaj lub przejdź">
          <CommandInput
            placeholder="Szukaj faktury, kontrahenta albo ekranu…"
            value={search}
            onValueChange={onSearchChange}
          />
          <CommandList>
            {remote.status !== 'loading' && remote.status !== 'error' ? (
              <CommandEmpty>Brak wyników.</CommandEmpty>
            ) : null}
            <CommandGroup heading={PALETTE_NAV_GROUP}>
              {navEntries.map((e) => (
                <CommandItem
                  key={e.value}
                  value={e.value}
                  keywords={e.keywords}
                  onSelect={() => go(e.href)}
                >
                  <e.icon aria-hidden />
                  <span>{e.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading={PALETTE_ACTIONS_GROUP}>
              {actionEntries.map((e) => (
                <CommandItem
                  key={e.value}
                  value={e.value}
                  keywords={e.keywords}
                  onSelect={() => go(e.href)}
                >
                  <e.icon aria-hidden />
                  <span>{e.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            {hasQuery && remote.status === 'error' ? (
              <p role="alert" className="text-destructive px-3 py-2 text-xs">
                {remote.message}
              </p>
            ) : null}
            {hasQuery && remote.status === 'loading' ? (
              <p role="status" aria-live="polite" className="text-muted-foreground px-3 py-2 text-xs">
                Szukam…
              </p>
            ) : null}
            {invoices.length > 0 ? (
              <>
                <CommandSeparator />
                <CommandGroup heading="Faktury">
                  {invoices.map((inv) => (
                    <CommandItem
                      key={inv.id}
                      // Wartość zawiera frazę, więc własny filtr cmdk nie ukryje wyniku z bazy.
                      value={`faktura-${inv.id}-${search}`}
                      onSelect={() => go(`/invoices/${inv.id}`)}
                    >
                      <RiFileList3Line aria-hidden />
                      <span>{inv.number}</span>
                      <span className="text-muted-foreground truncate">{inv.buyer}</span>
                      <span className="text-muted-foreground ml-auto shrink-0">{inv.grossLabel}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            ) : null}
            {contractors.length > 0 ? (
              <>
                <CommandSeparator />
                <CommandGroup heading="Kontrahenci">
                  {contractors.map((c) => (
                    <CommandItem
                      key={c.id}
                      value={`kontrahent-${c.id}-${search}`}
                      onSelect={() =>
                        go(`/contractors?q=${encodeURIComponent(c.nip || c.name)}`)
                      }
                    >
                      <RiUserLine aria-hidden />
                      <span>{c.name}</span>
                      <span className="text-muted-foreground ml-auto shrink-0">{c.nip}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            ) : null}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
