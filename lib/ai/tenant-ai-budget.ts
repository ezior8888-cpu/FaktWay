/**
 * Budżet AI firmy dla OCR i klasyfikatora kosztów (AUD-107, decyzja B7
 * z 02.10.2026).
 *
 * Do 02.10.2026 OCR i klasyfikator wołały model bez żadnego limitu — jedno
 * konto (także trial) mogło wygenerować dowolny rachunek u Anthropic, a jedyny
 * bezpiecznik (`lib/flo/budget.ts`) był podpięty tylko do niewdrożonego
 * agenta FLO. Teraz:
 *   - 3 zł miesięcznie na firmę (`MONTHLY_HARD_LIMIT_PLN`, ta sama tabela
 *     `flo_usage` co agent FLO — przy obecnych cenach ≈ 55 rozpoznań OCR),
 *   - dzienny limit liczby rozpoznań OCR i klasyfikacji (pętla ponowień albo
 *     seria zdjęć nie wypali miesiąca w jeden dzień),
 *   - alarm w Sentry po przekroczeniu dwukrotności celu miesięcznego.
 * Dzienny limit KOSZTU agenta FLO (0,6 zł) tu nie obowiązuje — klient może
 * mieć jeden dzień z paczką paragonów.
 *
 * Błąd odczytu zużycia = odmowa: nie wiemy, ile już kosztowało.
 */

import * as Sentry from '@sentry/nextjs';

import { evaluateBudget, readSpend, recordUsage } from '@/lib/flo/budget';
import { checkRateLimit } from '@/lib/rate-limit';

export const AI_DAILY_OCR_LIMIT = 40;
export const AI_DAILY_CLASSIFY_LIMIT = 200;

/** Model OCR i klasyfikatora (`lib/anthropic/client.ts`) w cenniku `budget.ts`. */
const AI_TOOLS_MODEL = 'claude-sonnet-4-6' as const;

export type TenantAiKind = 'ocr' | 'classify';
export type TenantAiBudget = { allowed: true } | { allowed: false; message: string };

/**
 * Komunikat odmowy trafia do zadania OCR (`error_message`, widoczny przy
 * „Dodaj wydatek”) i do powiadomienia, które process-ocr ucina do 80 znaków,
 * więc pierwsze zdanie mówi, kiedy limit wraca. Wpisu ręcznego kosztu nie ma
 * (plan kompletnej aplikacji, 2.6; formularz to krok 3.8), dlatego drogą jest
 * ponowne wgranie dokumentu. Okna, o których mówi komunikat, sprawdza
 * tests/unit/ai-limit-firmy.test.ts (dzienny: 24 godziny kroczące) i
 * tests/unit/koszt-bez-wpisu-recznego.test.ts (miesięczny: od 1. dnia miesiąca).
 */
export async function checkTenantAiBudget(tenantId: string, kind: TenantAiKind): Promise<TenantAiBudget> {
  let verdict: ReturnType<typeof evaluateBudget>;
  try {
    verdict = evaluateBudget(await readSpend(tenantId));
  } catch {
    return {
      allowed: false,
      message: 'Automatyczne rozpoznawanie dokumentów jest chwilowo niedostępne. Spróbuj ponownie później.',
    };
  }

  if (!verdict.allowed && verdict.reason === 'monthly') {
    return {
      allowed: false,
      message: 'Wykorzystano miesięczny limit odczytu dokumentów, wróci od następnego miesiąca. Wgraj dokument ponownie, gdy limit się odnowi.',
    };
  }
  if (verdict.allowed && verdict.alert) {
    Sentry.captureMessage('AI: firma przekroczyła dwukrotność miesięcznego celu kosztu', {
      level: 'warning',
      tags: { area: 'ai.tenant-budget', kind },
      extra: { tenantId, spentPln: verdict.spentPln },
    });
  }

  const daily = await checkRateLimit({
    bucket: kind === 'ocr' ? 'ai_ocr' : 'ai_classify',
    identifier: tenantId,
    limit: kind === 'ocr' ? AI_DAILY_OCR_LIMIT : AI_DAILY_CLASSIFY_LIMIT,
    windowSeconds: 24 * 60 * 60,
  });
  if (!daily.allowed) {
    return {
      allowed: false,
      message: 'Wykorzystano dzienny limit odczytu dokumentów, wróci w ciągu 24 godzin. Wgraj dokument ponownie, gdy limit się odnowi.',
    };
  }
  return { allowed: true };
}

/** Zapis zużycia po wywołaniu modelu. Błąd zapisu nie cofa wyniku OCR. */
export async function recordTenantAiUsage(
  tenantId: string,
  usage: { inputTokens: number; outputTokens: number },
): Promise<void> {
  try {
    await recordUsage(tenantId, AI_TOOLS_MODEL, usage);
  } catch (e) {
    Sentry.captureException(e, { tags: { area: 'ai.tenant-budget' } });
  }
}
