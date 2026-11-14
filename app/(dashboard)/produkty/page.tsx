import Link from 'next/link';
import { RiAddLine, RiSearchLine } from '@remixicon/react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { sanitizeSearch } from '@/lib/invoices/list-query';
import { listProducts } from '@/lib/produkty/baza';
import type { ProductListItem } from '@/lib/produkty/model';
import { getPageContext } from '@/lib/supabase/page-context';

import { ProductFormDialog } from './_components/product-form-dialog';
import { ProductsList } from './_components/products-list';

export const dynamic = 'force-dynamic';

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

/**
 * Produkty i usługi (plan kompletnej aplikacji, krok 2.6, część 1): katalog
 * firmy na tabeli `products`. Szukanie po nazwie (`?q=`) i „pokaż
 * zarchiwizowane” (`?zarchiwizowane=1`) są w adresie. Błąd odczytu to
 * komunikat, nie pusta lista („nie wiem” to nie „brak”).
 */
export default async function ProductsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { supabase, tenantId } = await getPageContext();
  const sp = (await searchParams) ?? {};
  const q = sanitizeSearch(first(sp.q));
  const archived = first(sp.zarchiwizowane) === '1';

  let rows: ProductListItem[] = [];
  let readFailed = false;
  try {
    rows = await listProducts(supabase, tenantId, { q, archived });
  } catch (error) {
    console.error('[produkty] lista:', error);
    readFailed = true;
  }

  const qParam = q ? `q=${encodeURIComponent(q)}` : '';
  const toggleHref = archived
    ? `/produkty${qParam ? `?${qParam}` : ''}`
    : `/produkty?${[qParam, 'zarchiwizowane=1'].filter(Boolean).join('&')}`;

  return (
    <div className='ff-page-fill flex flex-col gap-6'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div>
          <h1 className='text-2xl font-semibold tracking-tight'>Produkty i usługi</h1>
          <p className='text-muted-foreground text-sm'>
            Katalog pozycji, które wystawiasz najczęściej: nazwa, jednostka, cena netto i stawka VAT.
          </p>
        </div>
        <ProductFormDialog
          trigger={
            <Button>
              <RiAddLine />
              Nowy produkt lub usługa
            </Button>
          }
        />
      </div>

      <div className='flex flex-wrap items-center gap-3'>
        <form method='get' action='/produkty' className='flex flex-1 items-center gap-2'>
          <div className='relative w-full max-w-sm'>
            <RiSearchLine className='text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2' />
            <Input name='q' defaultValue={q} placeholder='Szukaj po nazwie' className='pl-8' aria-label='Szukaj po nazwie' />
          </div>
          {archived ? <input type='hidden' name='zarchiwizowane' value='1' /> : null}
          <Button type='submit' variant='outline'>
            Szukaj
          </Button>
        </form>
        <Link href={toggleHref} className={buttonVariants({ variant: 'ghost' })}>
          {archived ? 'Pokaż aktywne' : 'Pokaż zarchiwizowane'}
        </Link>
      </div>

      {readFailed ? (
        <Alert variant='destructive'>
          <AlertTitle>Nie udało się wczytać produktów</AlertTitle>
          <AlertDescription>Odśwież stronę za chwilę. Jeśli błąd wróci, napisz do pomocy FaktWay.</AlertDescription>
        </Alert>
      ) : rows.length === 0 ? (
        <Card className='text-muted-foreground p-6 text-sm shadow-none'>
          {q
            ? `Brak produktów pasujących do „${q}”.`
            : archived
              ? 'Nie masz zarchiwizowanych produktów.'
              : 'Nie masz jeszcze produktów w katalogu. Dodaj pierwszy przyciskiem powyżej.'}
        </Card>
      ) : (
        <Card className='flex-1 shadow-none'>
          <ProductsList rows={rows} />
        </Card>
      )}
    </div>
  );
}
