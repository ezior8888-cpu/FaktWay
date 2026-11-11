import Link from 'next/link';
import { RiAddLine, RiDownload2Line, RiSubtractLine } from '@remixicon/react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { getCashRegister, getCashReportData, hasCashDocuments } from '@/lib/kasa/baza';
import { buildCashReport, canWriteCash, dayPl, formatCashMoney, resolveCashPeriod, type CashRegister, type CashReport } from '@/lib/kasa/model';
import { CASH_BOOKS_NOTICE, CASH_INFO, CASH_LOAD_FAILED, cashBelowZeroText } from '@/lib/kasa/teksty';
import { getPageContext } from '@/lib/supabase/page-context';
import { cn } from '@/lib/utils';

import { CashDocumentsList } from './_components/cash-documents-list';
import { CashOpeningForm } from './_components/cash-opening-form';

export const dynamic = 'force-dynamic';

const TOUCH_TARGET = 'max-lg:min-h-[44px] max-lg:min-w-[44px]';

function Tile({ label, value, strong = false }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className='flex flex-col gap-1 border p-3'>
      <span className='text-muted-foreground text-xs'>{label}</span>
      <span className={cn('tabular-nums', strong ? 'text-lg font-semibold' : 'font-medium')}>{formatCashMoney(value)}</span>
    </div>
  );
}

function Header({ balance, canWrite }: { balance: number | null; canWrite: boolean }) {
  return (
    <div className='flex flex-wrap items-start justify-between gap-3'>
      <div>
        <h1 className='text-2xl font-semibold tracking-tight'>Kasa</h1>
        <p className='text-muted-foreground text-sm'>
          {balance === null ? 'Dowody wpłaty i wypłaty gotówki oraz raport kasowy.' : `Stan kasy dziś: ${formatCashMoney(balance)}`}
        </p>
      </div>
      {canWrite && balance !== null ? (
        <div className='flex flex-wrap gap-2'>
          <Link href='/kasa/nowy?rodzaj=KP' className={cn(buttonVariants(), TOUCH_TARGET)}>
            <RiAddLine aria-hidden />
            Wpłata (KP)
          </Link>
          <Link href='/kasa/nowy?rodzaj=KW' className={cn(buttonVariants({ variant: 'outline' }), TOUCH_TARGET)}>
            <RiSubtractLine aria-hidden />
            Wypłata (KW)
          </Link>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Kasa (plan kompletnej aplikacji, krok 3.7): stan kasy dziś, raport kasowy
 * za wybrany okres (stan na początek, wpłaty, wypłaty, stan na koniec, lista
 * dowodów) i PDF raportu. Bez otwartej kasy: stan początkowy. Odczyt klientem
 * z sesji (RLS 00194); błąd odczytu to komunikat, nie pusty raport („nie
 * wiem” to nie „brak gotówki”).
 */
export default async function KasaPage({ searchParams }: { searchParams: Promise<{ od?: string; do?: string }> }) {
  const { supabase, tenantId, role } = await getPageContext();
  const canWrite = canWriteCash(role);
  const today = todayInWarsaw();
  const query = await searchParams;

  let register: CashRegister | null = null;
  let report: CashReport | null = null;
  let balanceToday: number | null = null;
  let hasDocuments = true;
  let notice: string | null = null;
  let readFailed = false;
  try {
    register = await getCashRegister(supabase, tenantId);
    if (register) {
      const period = resolveCashPeriod({ od: query.od, do: query.do, today, openingDate: register.openingDate });
      notice = period.notice;
      const data = await getCashReportData(supabase, period.from, period.to);
      report = buildCashReport({
        from: period.from,
        to: period.to,
        openingDate: register.openingDate,
        balanceBefore: data.balanceBefore,
        documents: data.documents,
      });
      if (period.to === today) {
        balanceToday = report.balanceEnd;
      } else {
        const now = await getCashReportData(supabase, today, today);
        balanceToday = buildCashReport({ from: today, to: today, openingDate: register.openingDate, balanceBefore: now.balanceBefore, documents: now.documents }).balanceEnd;
      }
      hasDocuments = report.rows.length > 0 || (await hasCashDocuments(supabase, tenantId));
    }
  } catch (error) {
    console.error('[kasa] odczyt:', error);
    readFailed = true;
  }

  if (readFailed) {
    return (
      <div className='ff-page-fill flex flex-col gap-6'>
        <Header balance={null} canWrite={false} />
        <Alert variant='destructive'>
          <AlertTitle>Nie udało się wczytać kasy</AlertTitle>
          <AlertDescription>{CASH_LOAD_FAILED}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!register || !report) {
    return (
      <div className='ff-page-fill flex flex-col gap-6'>
        <Header balance={null} canWrite={canWrite} />
        <Alert>
          <AlertDescription>{CASH_INFO}</AlertDescription>
        </Alert>
        <Card className='shadow-none'>
          <CardHeader>
            <CardTitle>Otwórz kasę</CardTitle>
          </CardHeader>
          <CardContent>
            {canWrite ? (
              <CashOpeningForm tenantId={tenantId} today={today} initial={null} />
            ) : (
              <p className='text-muted-foreground text-sm'>
                Kasy jeszcze nie otwarto. Otwiera ją właściciel, administrator albo członek firmy. Księgowa ma tu wgląd.
              </p>
            )}
          </CardContent>
        </Card>
        <p className='text-muted-foreground text-xs'>{CASH_BOOKS_NOTICE}</p>
      </div>
    );
  }

  const pdfHref = `/api/kasa/raport/pdf?od=${report.from}&do=${report.to}`;

  return (
    <div className='ff-page-fill flex flex-col gap-6'>
      <Header balance={balanceToday} canWrite={canWrite} />

      {report.belowZero && report.lowest ? (
        <Alert variant='destructive'>
          <AlertDescription>{cashBelowZeroText(report.lowest.day, report.lowest.balance)}</AlertDescription>
        </Alert>
      ) : null}

      <Card className='shadow-none'>
        <CardHeader>
          <CardTitle>Raport kasowy</CardTitle>
        </CardHeader>
        <CardContent className='flex flex-col gap-4'>
          <form method='get' action='/kasa' className='flex flex-col gap-3 sm:flex-row sm:items-end'>
            <label className='flex flex-col gap-1 text-sm'>
              Od
              <Input type='date' name='od' defaultValue={report.from} min={register.openingDate} max={today} className={TOUCH_TARGET} />
            </label>
            <label className='flex flex-col gap-1 text-sm'>
              Do
              <Input type='date' name='do' defaultValue={report.to} min={register.openingDate} max={today} className={TOUCH_TARGET} />
            </label>
            <Button type='submit' variant='outline' className={TOUCH_TARGET}>
              Pokaż
            </Button>
            <a href={pdfHref} className={cn(buttonVariants({ variant: 'outline' }), TOUCH_TARGET)} download>
              <RiDownload2Line aria-hidden />
              Raport PDF
            </a>
          </form>
          {notice ? <p className='text-muted-foreground text-sm' role='status'>{notice}</p> : null}

          <p className='text-sm'>
            Okres od {dayPl(report.from)} do {dayPl(report.to)}
          </p>
          <div className='grid grid-cols-2 gap-2 lg:grid-cols-4'>
            <Tile label='Stan na początek okresu' value={report.balanceStart} />
            <Tile label='Wpłaty (KP)' value={report.receipts} />
            <Tile label='Wypłaty (KW)' value={report.payouts} />
            <Tile label='Stan na koniec okresu' value={report.balanceEnd} strong />
          </div>
        </CardContent>
        <CashDocumentsList rows={report.rows} />
      </Card>

      <Card className='shadow-none'>
        <CardHeader>
          <CardTitle>Stan początkowy kasy</CardTitle>
        </CardHeader>
        <CardContent className='flex flex-col gap-3'>
          <p className='text-sm'>
            {formatCashMoney(register.openingBalance)} na dzień {dayPl(register.openingDate)}.
          </p>
          {canWrite && !hasDocuments ? (
            <CashOpeningForm
              tenantId={tenantId}
              today={today}
              initial={{ openingDate: register.openingDate, openingBalance: register.openingBalance }}
            />
          ) : (
            <p className='text-muted-foreground text-xs'>
              Po pierwszym dowodzie stanu początkowego się nie zmienia. Różnicę w gotówce dokumentuje dowód KP albo KW.
            </p>
          )}
        </CardContent>
      </Card>

      <div className='text-muted-foreground flex flex-col gap-1 text-xs'>
        <p>{CASH_INFO}</p>
        <p>{CASH_BOOKS_NOTICE}</p>
      </div>
    </div>
  );
}
