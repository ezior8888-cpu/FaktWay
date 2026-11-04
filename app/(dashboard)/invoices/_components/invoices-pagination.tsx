import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';
import { buttonVariants } from '@/components/ui/button';
import { usePagination } from '@/hooks/use-pagination';
import { invoiceListHref, type InvoiceListParams } from '@/lib/invoices/list-query';
import { cn } from '@/lib/utils';

const DISABLED = 'pointer-events-none opacity-50';
// Numery stron i wielokropki tylko od `sm`: na telefonie (375 px) 5 numerów po 44 px
// + wielokropki + przyciski nie mieszczą się w jednym rzędzie i wypychają
// Poprzednia/Następna poza ekran, więc poniżej `sm` jest „Strona X z Y”.
const FROM_SM = 'hidden sm:block';

/**
 * Numer strony jak w Finorze (`data-table.tsx`): `Button size='icon'` —
 * bieżąca strona w kolorze akcentu (`default`), pozostałe na tle 10% akcentu.
 * `PaginationLink` daje wariant outline/ghost, więc klasy wariantu `default`
 * podajemy wprost (z nadpisaniem ciemnego tła wariantu outline).
 */
const PAGE_ACTIVE = cn(
  buttonVariants({ variant: 'default', size: 'icon' }),
  'hover:text-primary-foreground border-transparent dark:border-transparent dark:bg-primary dark:hover:bg-primary/80',
);
// Odstępstwo od Finory (WCAG 1.4.3): numer strony `text-accent-foreground`, nie `text-primary`.
// `text-primary` na `bg-primary/10` ma 4,44:1 (jasny) i 3,84 / 4,13:1 pod kursorem (`primary/20`,
// jasny / ciemny); `accent-foreground` daje 9,00 / 7,79:1 (jasny) i 8,93 / 7,43:1 (ciemny).
const PAGE_INACTIVE =
  'bg-primary/10 text-accent-foreground hover:bg-primary/20 hover:text-accent-foreground focus-visible:ring-primary/20 dark:hover:bg-primary/20 dark:focus-visible:ring-primary/40';

/**
 * Stopka listy jak w Finorze (`flex items-center justify-between gap-3 p-4
 * pb-0 max-sm:flex-col md:max-lg:flex-col`): „Pozycje X–Y z N” i paginacja.
 * Konieczność: strony to ZWYKŁE LINKI (`invoiceListHref` zachowuje filtry,
 * `na_stronie` i szukaną frazę) — działa bez JS i w nowych kartach, a serwer
 * jest właścicielem strony. Okno 5 numerów + pierwsza i ostatnia strona (Finora:
 * 2 numery bez skrajnych — przy setkach faktur nie dało się dojść do końca).
 * Telefon (< sm): Poprzednia, „Strona X z Y”, Następna; numery od `sm`.
 */
export function InvoicesPagination({ params, total }: { params: InvoiceListParams; total: number }) {
  const pages = Math.max(1, Math.ceil(total / params.perPage));
  const current = Math.min(params.page, pages);
  const first = total === 0 ? 0 : (current - 1) * params.perPage + 1;
  const last = Math.min(total, current * params.perPage);
  const { pages: window, showLeftEllipsis, showRightEllipsis } = usePagination({
    currentPage: current,
    totalPages: pages,
    paginationItemsToDisplay: 5,
  });
  const href = (page: number) => invoiceListHref(params, { page });
  const pageLink = (page: number) => (
    <PaginationLink
      href={href(page)}
      isActive={page === current}
      aria-label={`Strona ${page}`}
      className={page === current ? PAGE_ACTIVE : PAGE_INACTIVE}
    >
      {page}
    </PaginationLink>
  );

  return (
    <div className="flex items-center justify-between gap-3 p-4 pb-0 max-sm:flex-col md:max-lg:flex-col">
      <p className="text-muted-foreground text-sm whitespace-nowrap" aria-live="polite">
        {total === 0 ? 'Brak pozycji' : `Pozycje ${first}–${last} z ${total}`}
      </p>
      {/* Jak w Finorze: „Poprzednia / numery / Następna” zawsze, także przy jednej stronie. */}
      {total > 0 ? (
        <div>
          <Pagination aria-label="Strony listy faktur">
            {/* Zawijanie: od `sm` przy dotyku (44 px na numer) 10 stron nie mieści się do ok. 720 px. */}
            <PaginationContent className="flex-wrap justify-center">
              <PaginationItem>
                {current > 1 ? (
                  <PaginationPrevious href={href(current - 1)} />
                ) : (
                  <PaginationPrevious aria-disabled="true" tabIndex={-1} className={DISABLED} />
                )}
              </PaginationItem>
              <PaginationItem className="text-muted-foreground px-2 text-xs sm:hidden">
                {`Strona ${current} z ${pages}`}
              </PaginationItem>
              {window[0] !== undefined && window[0] > 1 ? (
                <PaginationItem className={FROM_SM}>{pageLink(1)}</PaginationItem>
              ) : null}
              {showLeftEllipsis ? (
                <PaginationItem className={FROM_SM}>
                  <PaginationEllipsis />
                </PaginationItem>
              ) : null}
              {window.map((page) => (
                <PaginationItem key={page} className={FROM_SM}>
                  {pageLink(page)}
                </PaginationItem>
              ))}
              {showRightEllipsis ? (
                <PaginationItem className={FROM_SM}>
                  <PaginationEllipsis />
                </PaginationItem>
              ) : null}
              {window[window.length - 1] !== undefined && (window[window.length - 1] as number) < pages ? (
                <PaginationItem className={FROM_SM}>{pageLink(pages)}</PaginationItem>
              ) : null}
              <PaginationItem>
                {current < pages ? (
                  <PaginationNext href={href(current + 1)} />
                ) : (
                  <PaginationNext aria-disabled="true" tabIndex={-1} className={DISABLED} />
                )}
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </div>
      ) : null}
    </div>
  );
}
