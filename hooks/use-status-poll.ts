'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { unstable_isUnrecognizedActionError, useRouter } from 'next/navigation';

import { STATUS_POLL, startPollLoop, type PollSchedule } from '@/lib/polling/poll-loop';
import type { JobStatusesResult } from '@/lib/polling/read-statuses';

/**
 * Tyle odrzuconych z rzędu pytań (poza brakiem sieci) daje jedno
 * `router.refresh()`. Tak bramka logowania (`proxy.ts`) odpowiada na akcję po
 * wylogowaniu w innej karcie, przy wymaganym 2FA i w przerwie technicznej:
 * przekierowaniem, którego akcja nie przeczyta, a odświeżenie strony za nim
 * pójdzie. Nie od pierwszego razu: chwilowe 502 przy restarcie serwera daje
 * to samo odrzucenie, a odświeżenie przeniosłoby kartę na stronę błędu.
 */
const REJECTIONS_BEFORE_REFRESH = 3;

/** Zadanie w toku tak, jak pokazuje je strona: id i status z ostatniego renderu. */
export type PolledJob = { readonly id: string; readonly status: string };

/** Lekka akcja statusu z `app/actions/job-statuses.ts`. */
export type ReadJobStatuses = (ids: string[]) => Promise<JobStatusesResult>;

/**
 * Odpytywanie zadań w toku bez pełnego odświeżania strony (plan
 * skalowania 3000, sesja 11; REQ-08, CAC-V01, CAC-10).
 *
 * Takt (`lib/polling/poll-loop.ts`: rosnący odstęp, jedno pytanie naraz,
 * tylko widoczna karta) pyta lekką akcją `read` o statusy zadań w toku
 * i porównuje je ze statusami z ostatniego renderu. `router.refresh()` idzie
 * dopiero przy zmianie (inny status albo brak zadania w odpowiedzi). Jeśli
 * odświeżona strona nie dotrze przed następnym pytaniem, to pytanie odświeży
 * znowu. Brak sieci i chwilowy błąd bazy niczego nie odświeżają. Trzy
 * odrzucone pytania z rzędu dają jedno odświeżenie, które pójdzie za
 * przekierowaniem bramki logowania (`REJECTIONS_BEFORE_REFRESH`).
 * Akcja nieznana serwerowi (nowe wdrożenie) i odmowa odczytu
 * (`retryable: false`: brak dostępu, zła lista) kończą pytania jednym
 * odświeżeniem: inny build przeładuje kartę, a przy żywej sesji strona
 * pokaże ręczne „Odśwież” jak po limicie.
 *
 * Nowe zadanie zlecone gdzie indziej (inna karta, druga osoba) pojawi się
 * przy najbliższej zmianie statusu albo po ręcznym odświeżeniu.
 *
 * `capped`: minął limit harmonogramu (`STATUS_POLL`: 3 minuty); strona
 * pokazuje wtedy ręczne „Odśwież”, które woła `resume()` i `router.refresh()`.
 * Inny zestaw zadań w toku zaczyna odpytywanie od nowa. `schedule` ma być
 * stałą modułu (nowy obiekt w każdym renderze restartowałby pętlę).
 */
export function useStatusPoll({
  jobs,
  read,
  schedule = STATUS_POLL,
  onChange,
}: {
  /** Zadania w toku; pusta lista = brak odpytywania. */
  jobs: readonly PolledJob[];
  read: ReadJobStatuses;
  schedule?: PollSchedule;
  /** Woła się przy wykryciu zmiany, tuż przed `router.refresh()`. */
  onChange?: () => void;
}): { capped: boolean; resume: () => void } {
  const router = useRouter();
  const idsKey = jobs
    .map((job) => job.id)
    .sort()
    .join(',');
  const [capped, setCapped] = useState(false);
  // Inny zestaw zadań w toku: limit od nowa. Stan dopasowany w trakcie
  // renderu (wzorzec z dokumentacji Reacta), bez efektu.
  const [pollKey, setPollKey] = useState(idsKey);
  if (pollKey !== idsKey) {
    setPollKey(idsKey);
    setCapped(false);
  }

  // Statusy z ostatniego renderu i najnowsze `read` / `onChange` w refach:
  // nowa tablica `jobs` albo nowa funkcja z renderu nie restartuje pętli.
  const shownRef = useRef<ReadonlyMap<string, string>>(new Map());
  const readRef = useRef(read);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    shownRef.current = new Map(jobs.map((job) => [job.id, job.status]));
    readRef.current = read;
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    if (idsKey === '' || capped) return;
    const ids = idsKey.split(',');
    let active = true;
    let rejections = 0;
    const stop: () => void = startPollLoop({
      schedule,
      poll: async () => {
        let result: JobStatusesResult | undefined;
        try {
          result = await readRef.current(ids);
        } catch (error) {
          if (!active) return;
          if (unstable_isUnrecognizedActionError(error)) {
            // Nowe wdrożenie: serwer nie zna akcji ze starego buildu.
            // Odświeżenie wykryje inny build i przeładuje kartę.
            stop();
            setCapped(true);
            router.refresh();
            return;
          }
          // Brak sieci (`fetch` rzuca `TypeError`): stan nieznany, pytamy dalej.
          if (error instanceof TypeError) return;
          rejections += 1;
          if (rejections < REJECTIONS_BEFORE_REFRESH) return;
          rejections = 0;
          router.refresh();
          return;
        }
        rejections = 0;
        if (!active || !result) return;
        if (!result.success) {
          if (result.retryable) return;
          // Odmowa: dalsze pytania nic nie dadzą (archiwum nie ma limitu).
          stop();
          setCapped(true);
          router.refresh();
          return;
        }
        const now = new Map(result.statuses.map((row) => [row.id, row.status]));
        const shown = shownRef.current;
        if (ids.every((id) => now.get(id) === shown.get(id))) return;
        onChangeRef.current?.();
        router.refresh();
      },
      onBudgetSpent: () => {
        if (active) setCapped(true);
      },
    });
    return () => {
      active = false;
      stop();
    };
  }, [idsKey, capped, router, schedule]);

  const resume = useCallback(() => setCapped(false), []);
  return { capped, resume };
}
