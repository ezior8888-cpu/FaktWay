import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { getCashDocument, getCorrectionOf } from '@/lib/kasa/baza';
import { canWriteCash, type CashDocument } from '@/lib/kasa/model';
import { CASH_LOAD_FAILED } from '@/lib/kasa/teksty';
import { getPageContext } from '@/lib/supabase/page-context';

import { CashDocumentView } from '../_components/cash-document-view';

export const dynamic = 'force-dynamic';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Podgląd dowodu kasowego (krok 3.7): dowód aktywnej firmy z odczytu klientem
 * z sesji (RLS 00194 i filtr `tenant_id`); dowód innej firmy to 404. PDF
 * i korekta z tego ekranu.
 */
export default async function DowodKasowyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_SHAPE.test(id)) notFound();
  const { supabase, tenantId, role } = await getPageContext();

  let cash: CashDocument | null = null;
  let correction: { id: string; number: string } | null = null;
  try {
    cash = await getCashDocument(supabase, tenantId, id);
    if (cash && cash.correctsId === null) correction = await getCorrectionOf(supabase, tenantId, id);
  } catch (error) {
    console.error('[kasa] dowód:', error);
    return (
      <div className='ff-page-fill flex flex-col gap-6'>
        <Alert variant='destructive'>
          <AlertTitle>Nie udało się wczytać dowodu</AlertTitle>
          <AlertDescription>{CASH_LOAD_FAILED}</AlertDescription>
        </Alert>
      </div>
    );
  }
  if (!cash) notFound();

  return (
    <div className='ff-page-fill flex flex-col gap-6'>
      <Link href='/kasa' className='text-muted-foreground text-sm hover:underline'>
        Wróć do Kasy
      </Link>
      <CashDocumentView cash={cash} correction={correction} canWrite={canWriteCash(role)} />
    </div>
  );
}
