'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Menu, X } from 'lucide-react';

/**
 * Menu na telefonie. Klient tylko po to, żeby zamknąć się po wyborze
 * kotwicy i po kliknięciu obok; reszta nagłówka renderuje się na serwerze.
 */
export function MobileMenu({ links }: { links: ReadonlyArray<{ label: string; href: string }> }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="md:hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="menu-telefon"
        aria-label={open ? 'Zamknij menu' : 'Otwórz menu'}
        className="flex size-10 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted"
      >
        {open ? <X className="size-5" /> : <Menu className="size-5" />}
      </button>

      {open ? (
        <div
          id="menu-telefon"
          className="absolute inset-x-0 top-14 z-50 origin-top rounded-2xl bg-popover p-2 text-popover-foreground shadow-2xl shadow-black/15 ring-1 ring-border animate-in fade-in zoom-in-95 slide-in-from-top-2 duration-200 motion-reduce:animate-none"
        >
          <ul className="flex flex-col">
            {[...links, { label: 'Zaloguj się', href: '/login' }].map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="block rounded-xl px-4 py-3 text-base hover:bg-muted"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
