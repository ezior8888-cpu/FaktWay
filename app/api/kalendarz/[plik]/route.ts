import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';

import { zbudujKalendarz } from '@/lib/kalendarz/ical';
import { skrotTokenuKalendarza, tokenZNazwyPliku } from '@/lib/kalendarz/token';
import { zbierzZdarzenia } from '@/lib/kalendarz/zbierz';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/server';

/**
 * `GET /api/kalendarz/<token>.ics` (krok 7.3 planu kompletnej aplikacji):
 * terminy firmy w formacie iCalendar dla Google, Apple i Outlook. Trasa jest
 * publiczna (`lib/supabase/middleware.ts`), a dostęp wyznacza niezgadywalny
 * token (256 bitów, w bazie tylko skrót; funkcja `calendar_feed_tenant`, 00182).
 *
 * Zły albo cofnięty token to 404 bez rozróżniania. Limit prób liczony od adresu
 * IP, żeby zgadywanie nie opłacało się, a zwykła aplikacja kalendarza (kilka
 * pobrań na godzinę) go nie dotykała.
 */

export const dynamic = 'force-dynamic';

const PROB_NA_OKNO = 60;
const OKNO_SEKUND = 900;

function nieZnaleziono(): NextResponse {
  return new NextResponse('Not found', {
    status: 404,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

function adresKlienta(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'nieznany';
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ plik: string }> }): Promise<Response> {
  const { plik } = await ctx.params;
  const token = tokenZNazwyPliku(plik);
  if (!token) return nieZnaleziono();

  const limit = await checkRateLimit({
    bucket: 'calendar_feed',
    identifier: adresKlienta(req),
    limit: PROB_NA_OKNO,
    windowSeconds: OKNO_SEKUND,
  });
  if (!limit.allowed) {
    return new NextResponse('Too many requests', {
      status: 429,
      headers: { 'Retry-After': String(Math.max(1, limit.retryAfter)), 'Cache-Control': 'no-store' },
    });
  }

  const admin = createAdminClient() as unknown as SupabaseClient;
  const { data: tenantId, error } = await admin.rpc('calendar_feed_tenant', {
    p_token_hash: skrotTokenuKalendarza(token),
  });
  if (error) {
    // „Nie wiem” to nie „nie ma”: klient kalendarza ma spróbować później, nie uznać adresu za martwy.
    Sentry.captureException(new Error(`calendar_feed_tenant: ${error.message}`), { tags: { area: 'kalendarz.ical' } });
    return new NextResponse('Service unavailable', {
      status: 503,
      headers: { 'Retry-After': '300', 'Cache-Control': 'no-store' },
    });
  }
  if (typeof tenantId !== 'string' || tenantId === '') return nieZnaleziono();

  const teraz = new Date();
  const zdarzenia = await zbierzZdarzenia(admin, tenantId, teraz);
  const tresc = zbudujKalendarz({ nazwa: 'FaktWay: terminy firmy', zdarzenia, teraz });

  return new NextResponse(tresc, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Cache-Control': 'private, max-age=900',
      'Content-Disposition': 'inline; filename="faktway-terminy.ics"',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
