'use client';

import { useLinkStatus } from 'next/link';

/**
 * Znacznik w dotkniętym linku nawigacji (zakładki w kartach, dolny pasek
 * telefonu), dopóki jego strona nie przyjdzie z serwera. Sam niczego nie
 * rysuje — podświetlenie i pasek postępu daje CSS (`.ff-section-tabs`,
 * `.ff-bottom-nav` w `app/globals.css`), więc link reaguje na dotyk od razu,
 * a nie dopiero po kilkuset milisekundach sieci telefonu.
 *
 * Musi stać wewnątrz `<Link>` (`useLinkStatus`). Gdy strona jest już
 * w pamięci (prefetch), Next nie zgłasza oczekiwania i znacznika nie ma —
 * przełączenie i tak jest natychmiast.
 */
export function LinkPendingMark() {
  const { pending } = useLinkStatus();
  return pending ? <span data-link-pending="" hidden /> : null;
}
