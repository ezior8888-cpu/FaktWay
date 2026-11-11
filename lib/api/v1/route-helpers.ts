import 'server-only';

import * as Sentry from '@sentry/nextjs';
import type { NextResponse } from 'next/server';

import { apiError, ApiUpstreamError } from '@/lib/api/v1/responses';

/**
 * Wspólne zakończenie trasy `/api/v1`: błąd bazy daje 503 bez szczegółów,
 * każdy inny wyjątek 500 z identyfikatorem żądania. Szczegóły idą do Sentry.
 */
export function apiFailure(error: unknown, requestId: string, headers: Record<string, string>): NextResponse {
  if (error instanceof ApiUpstreamError) {
    Sentry.captureMessage(error.message, { level: 'error', tags: { area: 'api.v1' }, extra: { requestId } });
    return apiError(503, 'service_unavailable', 'Publiczne API FaktWay jest chwilowo niedostępne. Spróbuj ponownie za kilka minut.', headers);
  }
  Sentry.captureException(error, { tags: { area: 'api.v1' }, extra: { requestId } });
  return apiError(500, 'internal_error', `Nieoczekiwany błąd. Podaj nam identyfikator żądania ${requestId}.`, headers);
}
