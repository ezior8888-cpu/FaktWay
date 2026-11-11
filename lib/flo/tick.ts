/**
 * Puls agenta FLO (krok 13 planu).
 *
 * Codziennie o 07:30 czasu polskiego — czyli zanim ktokolwiek otworzy
 * aplikację, ale już po ciszy nocnej. Ten cron jest miejscem, w którym
 * agent „patrzy na dane”: sprząta po sobie, a potem przechodzi reguły
 * funkcji — pierwszą codzienną jest K-01 (plan FLO 2, zadanie 1.1).
 *
 * ŚWIADOMIE NIE MA TU DRUGIEJ DEFINICJI DLA INNGESTA. Produkcja pracuje na
 * pg-boss od 18 sierpnia, a Inngest jest w trakcie odpinania — dokładanie
 * do niego nowych funkcji byłoby długiem w chwili powstania. Starsze zadania
 * mają jeszcze bliźniaki z okresu przejściowego, nowe już nie.
 */

import * as Sentry from '@sentry/nextjs';

import { logAuditSystem } from '@/lib/audit/log-system';
import {
  createDailyCap,
  readTodayCardCounts,
  type DailyCap,
} from '@/lib/flo/daily-cap';
import { floDb, type FloDbClient } from '@/lib/flo/db-types';
import { runKsefAuditSweep } from '@/lib/flo/functions/audit-sweep';
import {
  productionExpenseMissingSources,
  runMissingDocsSweep,
  type ExpenseMissingSources,
} from '@/lib/flo/functions/expense-missing-producer';
import {
  productionInvoiceMissingSources,
  runMissingInvoiceSweep,
  type InvoiceMissingSources,
} from '@/lib/flo/functions/invoice-missing-producer';
import {
  productionOnboardingSources,
  runOnboardingSweep,
  type OnboardingSources,
} from '@/lib/flo/functions/onboarding-producer';
import {
  productionPaymentConfirmSources,
  runPaymentConfirmSweep,
  type PaymentConfirmSources,
} from '@/lib/flo/functions/payment-confirm-producer';
import { expireStale } from '@/lib/flo/proposals';
import { emptySweep, type FloSweepResult } from '@/lib/flo/sweep';
import type { JobLogger } from '@/lib/jobs/logger';
import type { JobContext } from '@/lib/jobs/registry';
import { createAdminClient } from '@/lib/supabase/admin';
import type { FloProposalKind } from '@/types/flo';

/**
 * Po tylu minutach propozycja w stanie „wykonuję” jest uznana za porzuconą.
 *
 * Wykonawca zwalnia ją sam, gdy coś pójdzie nie tak — ale jeśli worker
 * zginie w połowie (restart kontenera, OOM), nie ma kto tego zrobić.
 * Bez tego strażnika karta zostałaby zablokowana na zawsze, a klient
 * patrzyłby na „wykonuję” do końca świata. Cisza jest stanem zabronionym,
 * więc i wieczne „w toku” też.
 */
const STUCK_AFTER_MS = 15 * 60_000;

/**
 * Co JEDNA reguła zrobiła w jednym przebiegu.
 *
 * `kind` to ten sam napis, co w `flo_proposals.kind`. Dzięki temu wynik
 * pulsu daje się zestawić z tym, co naprawdę leży w bazie, bez tłumaczenia
 * sobie w głowie, że „confirmAsked" znaczy `payment.confirm`.
 */
export interface FloRuleRun extends FloSweepResult {
  kind: FloProposalKind;
}

/**
 * Kroki sprzątania na początku pulsu: wygaszanie kart po terminie
 * i podnoszenie kart porzuconych w „wykonuję”.
 */
export type FloCleanupStep = 'expire' | 'release';

/** Jak awaria kroku sprzątania wygląda w linii operatora. */
const CLEANUP_FAILED: Record<FloCleanupStep, string> = {
  expire: 'wygaszanie padło',
  release: 'podnoszenie padło',
};

export interface FloTickResult {
  /** Sprzątanie — nie należy do żadnej reguły z osobna. */
  expired: number;
  released: number;
  /**
   * Kroki sprzątania, które w tym przebiegu padły (FLO-01). Liczba kroku,
   * który padł, jest wtedy zerem z braku wiedzy, a nie z braku kart — stąd
   * osobne pole zamiast samego zera.
   */
  failedCleanup: FloCleanupStep[];
  /**
   * Jedna pozycja na regułę, w kolejności przebiegu.
   *
   * Reguła, która dziś nie startowała (audyt poza pierwszym dniem miesiąca),
   * ma tu swoje zera. Brak pozycji znaczyłby „nie ma takiej reguły", a to
   * co innego niż „reguła przeszła i nie miała nic do powiedzenia".
   */
  rules: FloRuleRun[];
  /**
   * Ile kart zatrzymał dzienny limit (K1.4). Zero to stan normalny; liczba
   * rosnąca z dnia na dzień znaczy, że reguły chcą mówić częściej, niż
   * klient jest w stanie słuchać — i że limit trzyma lawinę.
   */
  withheld: number;
  /**
   * Nieudane przebiegi reguł na kontach — każda reguła liczona osobno, więc
   * konto, na którym padły dwie, liczy się dwa razy. Puls za każdym razem
   * szedł dalej.
   */
  failedTenants: number;
}

/**
 * Skąd puls bierze dane poza tabelami agenta.
 *
 * Wstrzykiwalne z tego samego powodu co `db`: testy pulsu mają chodzić na
 * atrapie, a nie po bazie z `.env.local`.
 */
export interface FloTickSources {
  /** Konta, na które puls patrzy. */
  listTenantIds: () => Promise<string[]>;
  paymentConfirm: PaymentConfirmSources;
  expenseMissing: ExpenseMissingSources;
  invoiceMissing: InvoiceMissingSources;
  onboarding: OnboardingSources;
  /**
   * Globalny wyłącznik dla reguł, które nie mają własnych źródeł (X-05).
   * Wstrzykiwany tylko w testach.
   */
  readGlobalKill?: () => Promise<boolean>;
}

/** Wszystko, czego reguła potrzebuje, żeby przejść po kontach. */
interface FloRuleContext {
  tenantIds: string[];
  now: Date;
  db: FloDbClient;
  sources: FloTickSources;
  /** Wspólny dzienny limit nowych kart (K1.4). */
  cap: DailyCap;
  logger?: JobLogger;
}

interface FloRule {
  kind: FloProposalKind;
  /** Czy reguła startuje dziś. Brak pola znaczy: codziennie. */
  runsToday?: (now: Date) => boolean;
  sweep: (ctx: FloRuleContext) => Promise<FloSweepResult>;
}

/**
 * KOLEJNOŚĆ TEJ TABLICY JEST KOLEJNOŚCIĄ PULSU i nie jest przypadkowa:
 * najpierw fakty (co wpłynęło), potem propozycje, na końcu miękkie
 * podpowiedzi. Agent najpierw ustala stan świata, a dopiero potem ma prawo
 * cokolwiek na tej podstawie sugerować. Kolejność decyduje też o tym, kto
 * dostanie ostatnie wolne miejsce pod dziennym limitem.
 *
 * NOWA REGUŁA TO JEDNA POZYCJA DOPISANA NA KOŃCU — nie dwa nowe pola
 * w wyniku pulsu i nie kolejny blok w `runFloTick`. Po to ta tablica
 * powstała (plan FLO 2, K1.3).
 */
const RULES: readonly FloRule[] = [
  {
    // X-05: audyt porządku chodzi RAZ W MIESIĄCU, nie codziennie — to
    // przegląd papierów, a nie sprawa bieżąca. Codzienne przypominanie
    // o tych samych zaległościach zamieniłoby go w listę zarzutów.
    kind: 'ksef.audit',
    runsToday: isFirstBusinessDay,
    sweep: ({ tenantIds, now, db, sources, cap, logger }) =>
      runKsefAuditSweep(tenantIds, now, db, {
        readGlobalKill: sources.readGlobalKill,
        logger,
        cap,
      }),
  },
  {
    // K-01 (zadanie 1.1): „zapłacił?" dobę po terminie.
    kind: 'payment.confirm',
    sweep: ({ tenantIds, now, db, sources, cap, logger }) =>
      runPaymentConfirmSweep(tenantIds, now, db, sources.paymentConfirm, logger, cap),
  },
  {
    // W-04 (K1.9): „co miesiąc masz tu koszt, a w tym miesiącu nie widzę
    // dokumentu". Sama reguła milczy przed dziesiątym dniem miesiąca.
    kind: 'expense.missing',
    sweep: ({ tenantIds, now, db, sources, cap, logger }) =>
      runMissingDocsSweep(tenantIds, now, db, sources.expenseMissing, logger, cap),
  },
  {
    // P-03 (K1.10): „zwykle fakturujesz ich około 10., w tym miesiącu nie
    // widzę faktury". TYLKO pytanie — szkice to P-01/P-02 i osobna decyzja.
    kind: 'invoice.draft',
    sweep: ({ tenantIds, now, db, sources, cap, logger }) =>
      runMissingInvoiceSweep(tenantIds, now, db, sources.invoiceMissing, logger, cap),
  },
  {
    // O-01 (K1.11): pierwsze kroki na nowym koncie. NA KOŃCU, bo to
    // najmiększa z reguł: prowadzenie za rękę ustępuje wszystkiemu, co
    // dotyczy pieniędzy albo terminów.
    kind: 'onboarding.step',
    sweep: ({ tenantIds, now, db, sources, cap, logger }) =>
      runOnboardingSweep(tenantIds, now, db, sources.onboarding, logger, cap),
  },
];

export async function runFloTick(
  ctx?: JobContext,
  now: Date = new Date(),
  db: FloDbClient = floDb(),
  sources: FloTickSources = productionTickSources(),
): Promise<FloTickResult> {
  // Sprzątanie: każdy krok osobno (FLO-01). Wcześniej wyjątek z wygaszania
  // zatrzymywał cały puls — wszystkie reguły na wszystkich kontach — choć
  // żadna reguła nie potrzebuje wyniku sprzątania. Karta, której dziś nie
  // wygaszono, czeka do jutra — wykonawca i tak odmawia karty po terminie
  // (`execute.ts`) — a porzucona zostaje w „wykonuję” do następnego pulsu.
  const failedCleanup: FloCleanupStep[] = [];
  const expired = await cleanupStep(
    'expire',
    () => expireStale(now, db),
    failedCleanup,
    ctx?.logger,
  );
  const released = await cleanupStep(
    'release',
    () => releaseStuck(now, db),
    failedCleanup,
    ctx?.logger,
  );

  // Lista kont i dzisiejsze liczniki kart NIE są izolowane: to dane
  // wejściowe reguł, a nie osobne kroki. Bez listy kont reguły nie mają po
  // czym chodzić, a bez liczników ponowny puls tego samego dnia dałby drugą
  // porcję kart (K1.4) — więc ich błąd ma zatrzymać przebieg.
  //
  // Jedna lista kont dla wszystkich reguł. Audyt miał kiedyś własne
  // `limit(200)` bez sortowania — konta ponad dwusetne mogły go nie dostać
  // nigdy.
  const tenantIds = await sources.listTenantIds();

  // Jeden limit na CAŁY przebieg, wspólny dla wszystkich reguł (K1.4).
  // Osobne limity per reguła nie zatrzymałyby lawiny, bo to właśnie suma
  // reguł zalewa konto. Punkt wyjścia to karty, które konto dostało już
  // dzisiaj — inaczej drugie uruchomienie pulsu dałoby drugą porcję.
  const cap = createDailyCap(await readTodayCardCounts(tenantIds, now, db));

  const ruleCtx: FloRuleContext = {
    tenantIds,
    now,
    db,
    sources,
    cap,
    logger: ctx?.logger,
  };

  const rules: FloRuleRun[] = [];
  for (const rule of RULES) {
    const startsToday = rule.runsToday?.(now) ?? true;
    const run = startsToday ? await rule.sweep(ruleCtx) : emptySweep();
    rules.push({ kind: rule.kind, ...run });
  }

  const result: FloTickResult = {
    expired,
    released,
    failedCleanup,
    rules,
    withheld: cap.withheld,
    failedTenants: rules.reduce((sum, rule) => sum + rule.failed, 0),
  };

  // Do tej pory te liczby nie trafiały NIGDZIE: worker ignoruje zwrotkę
  // handlera, więc wynik pulsu czytały wyłącznie testy. Jedna linia na
  // stdout to całe okno operatora na to, co agent zrobił w nocy.
  ctx?.logger.info(`[flo.tick] ${summarizeTick(result)}`);

  return result;
}

/**
 * Wynik jednej reguły — zera, gdy reguła w tym przebiegu nie startowała.
 *
 * Do czytania wyniku bez grzebania w tablicy; używają tego testy i wszystko,
 * co interesuje jedna konkretna reguła.
 */
export function ruleRun(
  result: FloTickResult,
  kind: FloProposalKind,
): FloRuleRun {
  return result.rules.find((rule) => rule.kind === kind) ?? { kind, ...emptySweep() };
}

/**
 * Jedna linia do logów workera — funkcja czysta, więc da się ją testować
 * bez odpalania pulsu.
 *
 * Reguły, które nic nie zrobiły, są pomijane: linia ma być do przeczytania
 * jednym rzutem oka, a nie listą dwunastu zer. Sprzątanie zostaje zawsze —
 * jest dowodem, że puls w ogóle się odbył. Krok sprzątania, który padł,
 * pokazuje awarię zamiast zera, bo zero wyglądałoby jak spokojna noc.
 */
export function summarizeTick(result: FloTickResult): string {
  const failed = new Set(result.failedCleanup);
  const parts = [
    failed.has('expire') ? CLEANUP_FAILED.expire : `wygasłe ${result.expired}`,
    failed.has('release')
      ? CLEANUP_FAILED.release
      : `podniesione ${result.released}`,
  ];

  for (const rule of result.rules) {
    if (rule.asked === 0 && rule.closed === 0 && rule.failed === 0) continue;
    const awarie = rule.failed > 0 ? ` (awarie ${rule.failed})` : '';
    parts.push(`${rule.kind} +${rule.asked}/-${rule.closed}${awarie}`);
  }

  if (result.withheld > 0) parts.push(`limit zatrzymał ${result.withheld}`);

  return parts.join(' · ');
}

export function productionTickSources(): FloTickSources {
  return {
    listTenantIds: readActiveTenantIds,
    paymentConfirm: productionPaymentConfirmSources(),
    expenseMissing: productionExpenseMissingSources(),
    invoiceMissing: productionInvoiceMissingSources(),
    onboarding: productionOnboardingSources(),
  };
}

/** Rozmiar strony przy czytaniu kont — PostgREST i tak tnie duże odpowiedzi. */
const TENANT_PAGE = 500;

/**
 * Aktywne, nieusunięte konta — ta sama definicja co w metrykach panelu.
 *
 * Czytane stronami do końca. Stały limit bez stronicowania oznaczałby, że
 * konto numer 501 nie dostaje pytań nigdy, i nikt by tego nie zauważył.
 */
async function readActiveTenantIds(): Promise<string[]> {
  const supabase = createAdminClient();
  const ids: string[] = [];

  for (let from = 0; ; from += TENANT_PAGE) {
    const { data, error } = await supabase
      .from('tenants')
      .select('id')
      .eq('is_active', true)
      .is('deleted_at', null)
      .order('id')
      .range(from, from + TENANT_PAGE - 1);

    if (error) throw new Error(error.message);
    const page = data ?? [];
    ids.push(...page.map((row) => row.id));
    if (page.length < TENANT_PAGE) return ids;
  }
}

/**
 * Podnosi propozycje porzucone w połowie wykonania.
 *
 * Wracają do stanu „zatwierdzona”, a nie „otwarta”: człowiek już się na nie
 * zgodził, więc odbieranie mu tej zgody byłoby cofaniem jego decyzji.
 * Żeton zgody jest w tym momencie zużyty, więc realne wykonanie i tak
 * wymaga ponownego kliknięcia — i dobrze, bo nie wiemy, jak daleko zaszła
 * przerwana próba.
 *
 * JEDEN UPDATE Z WARUNKIEM W ZAPYTANIU (FLO-01) zamiast odczytu listy id
 * i odsyłania jej w adresie. Warunek AUD-111 („nadal wykonuję”) sprawdza
 * się w chwili zapisu, a baza odsyła dokładnie karty podniesione: zakończona
 * w trakcie przebiegu nie wraca do zatwierdzenia i nie dostaje wpisu
 * w audycie. PostgREST (od wersji 10) nie ucina wierszy zwracanych przez
 * zapis — limit 1000 dotyczy odczytu — więc wpis dostaje każda podniesiona.
 */
async function releaseStuck(now: Date, db: FloDbClient): Promise<number> {
  const cutoff = new Date(now.getTime() - STUCK_AFTER_MS).toISOString();

  const { data, error } = await db
    .from('flo_proposals')
    .update({ status: 'approved' })
    .eq('status', 'executing')
    .lt('approved_at', cutoff)
    .select('id, tenant_id, kind');
  if (error) throw new Error(error.message);
  const rows = data ?? [];

  for (const row of rows) {
    // Operator ma o tym wiedzieć: pojedynczy przypadek to restart kontenera,
    // seria oznacza, że wykonawca gdzieś się wiesza.
    await logAuditSystem({
      tenantId: row.tenant_id,
      userId: null,
      action: 'flo.proposal.failed',
      entityType: 'flo_proposal',
      entityId: row.id,
      metadata: {
        actor: 'flo',
        kind: row.kind,
        error: 'porzucona w stanie „wykonuję" — podniesiona przez flo.tick',
      },
    });
  }

  return rows.length;
}

/**
 * Jeden krok sprzątania z izolacją awarii — ten sam wzór co `runSweep`:
 * Sentry, log workera, wpis w wyniku i puls idzie dalej. Krok, który padł,
 * zwraca zero; że to zero znaczy „nie wiadomo”, mówi `failedCleanup`.
 */
async function cleanupStep(
  step: FloCleanupStep,
  run: () => Promise<number>,
  failed: FloCleanupStep[],
  logger?: Pick<JobLogger, 'error'>,
): Promise<number> {
  try {
    return await run();
  } catch (e) {
    failed.push(step);
    Sentry.captureException(e, { tags: { job: 'flo-tick', step } });
    const message = e instanceof Error ? e.message : 'nieznany błąd';
    (logger ?? console).error(`[flo.tick] ${CLEANUP_FAILED[step]}: ${message}`);
    return 0;
  }
}

/**
 * Czy dziś jest pierwszy dzień miesiąca (albo poniedziałek po nim).
 *
 * Audyt wpadający w sobotę zobaczyłby klient dopiero po weekendzie, kiedy
 * karta ma już trzy dni i wygląda na zaniedbaną przez agenta.
 */
function isFirstBusinessDay(now: Date): boolean {
  const day = now.getUTCDate();
  const weekday = now.getUTCDay();
  if (day === 1) return weekday !== 0 && weekday !== 6;
  if (day === 2) return weekday === 1;
  if (day === 3) return weekday === 1;
  return false;
}
