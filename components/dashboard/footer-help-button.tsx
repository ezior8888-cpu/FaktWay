'use client';

import { OTWORZ_POMOC } from '@/lib/support/open-support-event';

/**
 * „Pomoc” w stopce panelu — otwiera ten sam panel pomocy co bąbelek
 * (`components/support/support-widget.tsx`), przez zdarzenie `OTWORZ_POMOC`.
 * Osobny plik, bo stopka jest Server Componentem.
 */
export function FooterHelpButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => window.dispatchEvent(new Event(OTWORZ_POMOC))}
    >
      Pomoc
    </button>
  );
}
