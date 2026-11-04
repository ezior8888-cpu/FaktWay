'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { RiLoader4Line, RiPrinterLine } from '@remixicon/react';

import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const EXPORTS_HREF = '/reports/exports';

/** Prefetch RSC `/reports/exports` gdy user jest w `(dashboard)` — skraca opóźnienie pierwszego kliku. */
export function PrefetchExportsRoute() {
  const router = useRouter();
  useEffect(() => {
    void router.prefetch(EXPORTS_HREF);
  }, [router]);
  return null;
}

/**
 * Link „Eksport PDF” (karta „Podsumowanie podatku VAT” na `/przeplywy`,
 * przycisk konturowy Finory): agresywny prefetch + natychmiastowy stan „busy”
 * na pointerdown (zanim App Router dokończy soft navigation).
 */
export function DashboardExportsPdfLink() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const armPrefetch = useCallback(() => {
    void router.prefetch(EXPORTS_HREF);
  }, [router]);

  useEffect(() => {
    void router.prefetch(EXPORTS_HREF);
  }, [router]);

  return (
    <Link
      href={EXPORTS_HREF}
      prefetch
      onPointerEnter={armPrefetch}
      onFocus={armPrefetch}
      onPointerDown={() => {
        armPrefetch();
        setBusy(true);
      }}
      aria-busy={busy}
      className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), busy && 'cursor-wait opacity-90')}
    >
      {busy ? (
        <RiLoader4Line className="animate-spin" aria-hidden />
      ) : (
        <RiPrinterLine aria-hidden />
      )}
      <span>{busy ? 'Przechodzenie…' : 'Eksport PDF'}</span>
    </Link>
  );
}
