import { RiArrowLeftSLine, RiArrowRightSLine } from '@remixicon/react';
import { Download, Eye } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Pagination, PaginationContent, PaginationItem } from '@/components/ui/pagination';
import type { PortalAccess, PortalPage } from '@/lib/accountant/portal-access';
import { formatTimestampDatePl } from '@/lib/format/iso-date';
import { cn } from '@/lib/utils';

/**
 * Części stron portalu księgowej (dokumenty i koszty, krok 6.2). Wygląd jak
 * dotąd na stronie portalu (plan Finora §2.2/E8: tylko Card i Table, bez
 * szkieletu panelu); nowe są tylko zakładki i strony listy.
 *
 * Linki portalu to zwykłe `<a>`, nie `next/link`: wejście na stronę portalu
 * zapisuje wpis w audycie i liczy się do limitu prób, a wstępne pobieranie
 * stron (prefetch) robiłoby to bez kliknięcia.
 */

export function PortalShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-background text-foreground min-h-screen p-4 lg:p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        {children}
        <div className="pt-4 pb-2 text-center">
          <p className="text-muted-foreground text-xs">Powered by FaktWay</p>
        </div>
      </div>
    </div>
  );
}

export function PortalHeader({ access, tenant }: { access: PortalAccess; tenant: { name: string; nip: string } }) {
  return (
    <Card className="shadow-none">
      <CardContent className="flex flex-wrap items-start justify-between gap-6">
        <div className="space-y-1">
          <p className="text-muted-foreground text-xs">Faktury udostępnione przez</p>
          <h1 className="text-2xl font-semibold tracking-tight">{tenant?.name}</h1>
          <p className="text-muted-foreground font-mono text-sm">NIP: {tenant?.nip}</p>
        </div>
        <div className="space-y-1.5 text-right">
          <Badge variant="secondary" className="font-normal">
            {access.access_level === 'download' ? (
              <>
                <Download aria-hidden />
                Z pobieraniem
              </>
            ) : (
              <>
                <Eye aria-hidden />
                Tylko podgląd
              </>
            )}
          </Badge>
          <p className="text-muted-foreground text-xs">
            Dostęp dla:{' '}
            <span className="text-foreground font-medium">{access.accountant_name}</span>
          </p>
          <p className="text-muted-foreground text-xs">
            Wygasa: {formatTimestampDatePl(access.expires_at)}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/** Adres strony portalu dla tokenu (`documents`: strona główna, `expenses`: koszty). */
export function portalHref(token: string, view: 'documents' | 'expenses'): string {
  const base = `/accountant/${encodeURIComponent(token)}`;
  return view === 'expenses' ? `${base}/expenses` : base;
}

export function PortalTabs({ token, active }: { token: string; active: 'documents' | 'expenses' }) {
  const tabs = [
    { value: 'documents' as const, label: 'Dokumenty' },
    { value: 'expenses' as const, label: 'Koszty' },
  ];
  return (
    <nav aria-label="Widok portalu" className="flex flex-wrap gap-2">
      {tabs.map((tab) => (
        <a
          key={tab.value}
          href={portalHref(token, tab.value)}
          aria-current={tab.value === active ? 'page' : undefined}
          className={buttonVariants({ variant: tab.value === active ? 'default' : 'outline' })}
        >
          {tab.label}
        </a>
      ))}
    </nav>
  );
}

export function PortalLimitedNotice() {
  return (
    <Card className="shadow-none">
      <CardContent className="space-y-1 py-6 text-center">
        <h1 className="text-lg font-semibold">Chwila przerwy</h1>
        <p className="text-muted-foreground text-sm">
          Za dużo otwarć portalu z tego adresu. Spróbuj ponownie za kilka minut.
        </p>
      </CardContent>
    </Card>
  );
}

const DISABLED = 'pointer-events-none opacity-50';

/**
 * Poprzednia, „Strona X z Y”, Następna. Tylko gdy stron jest więcej niż
 * jedna; strony to zwykłe linki (bez wstępnego pobierania).
 */
export function PortalPagination({
  page,
  hrefFor,
  label,
}: {
  page: PortalPage;
  hrefFor: (page: number) => string;
  label: string;
}) {
  if (page.pages <= 1) return null;
  const link = (target: number, text: string, icon: 'prev' | 'next') => {
    const enabled = icon === 'prev' ? page.page > 1 : page.page < page.pages;
    const content =
      icon === 'prev' ? (
        <>
          <RiArrowLeftSLine aria-hidden />
          {text}
        </>
      ) : (
        <>
          {text}
          <RiArrowRightSLine aria-hidden />
        </>
      );
    return enabled ? (
      <a href={hrefFor(target)} className={buttonVariants({ variant: 'ghost' })}>
        {content}
      </a>
    ) : (
      <span aria-disabled="true" className={cn(buttonVariants({ variant: 'ghost' }), DISABLED)}>
        {content}
      </span>
    );
  };

  return (
    <Pagination aria-label={label} className="border-t p-3">
      <PaginationContent className="flex-wrap justify-center">
        <PaginationItem>{link(page.page - 1, 'Poprzednia', 'prev')}</PaginationItem>
        <PaginationItem className="text-muted-foreground px-2 text-sm">
          {`Strona ${page.page} z ${page.pages}`}
        </PaginationItem>
        <PaginationItem>{link(page.page + 1, 'Następna', 'next')}</PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}
