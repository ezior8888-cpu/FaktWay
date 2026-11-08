import {
  FinanseSlot,
  KafelFakturSlot,
  KafelSredniejSlot,
  NaleznosciSlot,
  PrzychodSlot,
  RankingiSlot,
  VatSlot,
  type PulpitSlotProps,
} from '@/components/dashboard/finora/sloty';
import { kontekstDanych } from '@/lib/demo/tryb-danych';
import { recordTiming } from '@/lib/observability/timings';
import { getPageContext } from '@/lib/supabase/page-context';

/**
 * WŁAŚCICIEL: Bartosz (tor silnika) — kompozycja ekranu.
 *
 * Pulpit = strona Finance szablonu Finora 1:1 (decyzja Bartosza 19.10.2026):
 * ta sama siatka, karty, wykresy i animacje, bez FLO. Od E5
 * PLAN-PRAWDZIWE-DANE karty pokazują prawdziwe dane firmy (sloty
 * `components/dashboard/finora/sloty.tsx`), a przed weryfikacją KSeF — dane
 * przykładowe czytane tymi samymi loaderami z atrapy bazy. Tryb liczy
 * wyłącznie `kontekstDanych`; strona nie woła sama żadnej funkcji danych.
 *
 * Ładowanie (poprawka Bartosza 23.10.2026): dane wszystkich kart naraz,
 * strona renderuje się RAZ, w całości — bez szkieletów kart wskakujących po
 * kolei; wejście treści animuje `ff-route-content` (ten sam ruch co szablon
 * trasy), a `loading.tsx` tej trasy nie pokazuje obcego szkieletu.
 *
 * Pełna mapa: `docs/flo/UKLAD-DASHBOARDU.md`.
 */
export const dynamic = 'force-dynamic';

export default async function DashboardHomePage() {
  // Czas renderu Pulpitu (sesja, kontekst i dane wszystkich kart) — p50/p95
  // w linii `process.metrics` (plan skalowania, sesja 23).
  // eslint-disable-next-line react-hooks/purity -- komponent serwerowy renderuje się raz na żądanie, czas nie trafia do UI
  const startedAt = performance.now();
  const pageCtx = await getPageContext();
  const { supabase, tenantId, nowIso, tryb, kosztyKsefOd } = await kontekstDanych(pageCtx, new Date());
  const props: PulpitSlotProps = { supabase, tenantId, nowIso, tryb, kosztyKsefOd };

  // Sloty nie odrzucają (błąd loadera = karta błędu), więc `Promise.all` = `allSettled`.
  const [finanse, faktury, srednia, przychod, vat, naleznosci, rankingi] = await Promise.all([
    FinanseSlot({ ...props, className: 'col-span-full xl:col-span-4' }),
    KafelFakturSlot(props),
    KafelSredniejSlot(props),
    PrzychodSlot(props),
    VatSlot(props),
    NaleznosciSlot({ ...props, className: 'col-span-full lg:col-span-3 xl:col-span-2' }),
    RankingiSlot({ ...props, className: 'col-span-full xl:col-span-4' }),
  ]);
  // eslint-disable-next-line react-hooks/purity -- jak wyżej
  recordTiming('dashboard', performance.now() - startedAt);

  return (
    <div className="ff-route-content">
      <div className="grid grid-cols-6 gap-6">
        {/* Tytuł strony był w pasku górnym; pasek Finory go nie ma (21.10.2026). */}
        <h1 className="sr-only">Pulpit</h1>
        {finanse}

        <div className="col-span-full grid grid-cols-2 gap-6 lg:col-span-3 xl:col-span-2">
          {faktury}
          {srednia}

          {przychod}

          {vat}
        </div>

        {naleznosci}

        {rankingi}
      </div>
    </div>
  );
}
