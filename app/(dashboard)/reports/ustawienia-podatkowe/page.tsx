import { notFound } from 'next/navigation';

import { UstawieniaPodatkoweForm } from '@/components/ksiegowosc/ustawienia-podatkowe-form';
import { Card, CardContent } from '@/components/ui/card';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { readTenantBusinessStart } from '@/lib/invoices/business-start';
import { readTenantVatExemption } from '@/lib/invoices/vat-exemption';
import {
  czytajWersjeProfilu,
  domyslnyPoczatek,
  NAZWY_ETAPOW_ZUS,
  NAZWY_FORM,
  STAWKI_RYCZALTU,
  wersjaNa,
} from '@/lib/ksiegowosc/profil';
import { czyKsiegowoscWlaczona } from '@/lib/ksiegowosc/wylacznik';
import { getPageContext } from '@/lib/supabase/page-context';

export const dynamic = 'force-dynamic';

/**
 * „Ustawienia podatkowe” w Księgowości (plan księgowości JDG, K2, sekcja 8).
 *
 * Za wyłącznikiem modułu (obszar `ustawienia`): firma poza pilotażem dostaje
 * 404, tak jakby strony nie było. Profil czyta klient z sesji (RLS z 00166);
 * zapis robi `zapiszProfilPodatkowyAction`. Status VAT zostaje w ustawieniach
 * firmy (D3), tu jest tylko pokazany.
 */
export default async function UstawieniaPodatkowePage() {
  const ctx = await getPageContext();
  const werdykt = await czyKsiegowoscWlaczona(ctx.supabase, ctx.tenantId, 'ustawienia');
  if (!werdykt.wlaczony) notFound();

  const dzis = todayInWarsaw();
  const [wersje, zwolnienieVat, startDzialalnosci] = await Promise.all([
    czytajWersjeProfilu(ctx.supabase, ctx.tenantId),
    readTenantVatExemption(ctx.supabase, ctx.tenantId),
    readTenantBusinessStart(ctx.supabase, ctx.tenantId),
  ]);
  // Bieżąca wersja, a gdy wszystkie zaczynają się w przyszłości, najnowsza.
  const poczatkowa = wersjaNa(wersje, dzis) ?? wersje[wersje.length - 1] ?? null;
  const canEdit = ctx.role === 'owner' || ctx.role === 'admin';
  const statusVat = zwolnienieVat ? `Zwolnienie z VAT: ${zwolnienieVat}` : 'Czynny podatnik VAT';

  return (
    <div className="ff-tab-panel flex flex-1 flex-col gap-6">
      <h1 className="sr-only">Ustawienia podatkowe</h1>
      <Card>
        <CardContent>
          <UstawieniaPodatkoweForm
            poczatkowa={poczatkowa}
            domyslnyOd={poczatkowa?.validFrom ?? domyslnyPoczatek(dzis, startDzialalnosci)}
            canEdit={canEdit}
            statusVat={statusVat}
          />
        </CardContent>
      </Card>
      {wersje.length > 0 ? (
        <Card>
          <CardContent>
            <h2 className="text-sm font-medium">Historia ustawień</h2>
            <ul className="mt-3 flex flex-col gap-2 text-sm" aria-label="Wersje ustawień podatkowych">
              {[...wersje].reverse().map((w) => (
                <li key={w.id} className="flex flex-wrap justify-between gap-2">
                  <span className="font-medium">od {formatIsoDatePl(w.validFrom)}</span>
                  <span className="text-muted-foreground">
                    {NAZWY_FORM[w.forma]}
                    {w.forma === 'ryczalt' ? `, ${STAWKI_RYCZALTU.find((s) => s.pb === w.stawkaDomyslna)?.etykieta ?? ''}` : ''}
                    {', '}
                    {NAZWY_ETAPOW_ZUS[w.zusEtap]}
                    {w.zusOd ? ` od ${formatIsoDatePl(w.zusOd)}` : ''}
                    {w.chorobowe ? ', z chorobowym' : ''}
                    {w.najem ? ', najem z progiem 100 000 zł' : ''}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
