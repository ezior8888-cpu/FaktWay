import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createJobLogger, type JobLogger } from '@/lib/jobs/logger';
import { createAdminClient } from '@/lib/supabase/admin';

import {
  APP_NOTIFICATION_LIMITS,
  isAppNotificationKind,
  isAppNotificationLink,
  type AppNotificationInput,
} from './types';

/**
 * Zapis powiadomienia w dzwonku (plan kompletnej aplikacji, krok 8.1, część 2,
 * 00188). Jedno wywołanie RPC `app_notification_publish`: wpis dla każdego
 * aktywnego członka firmy, `ON CONFLICT DO NOTHING` na kluczu (odbiorca,
 * firma, rodzaj, obiekt). Ponowienie joba od zera z tym samym kluczem nic nie
 * dodaje (baza zwraca 0).
 *
 * Dwa warianty:
 * - `publishAppNotification` (fail-open) dla jobów, które robią coś ważniejszego
 *   (koszt ze skrzynki, przypomnienie o terminie): nigdy nie rzuca, błąd idzie
 *   do logu i Sentry, a job działa dalej;
 * - `writeAppNotification` (ścisły) dla kolejek dzwonka, które nic innego nie
 *   robią: rzuca, żeby pg-boss ponowił (UNIQUE chroni przed dublem).
 */

type Db = Pick<SupabaseClient, 'rpc'>;

/** Wpis, którego nie da się zapisać (zły link, pusty tytuł): ponowienie nie pomoże. */
export class AppNotificationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppNotificationInputError';
  }
}

/** Skrót po znakach (nie jednostkach UTF-16), jak `char_length` w CHECK-ach. */
function clip(text: string, max: number): string {
  const chars = Array.from(text.trim());
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`;
}

function prepare(input: AppNotificationInput) {
  // Kształt identyfikatora (UUID) sprawdza baza; tu tylko, że firma jest podana.
  if (typeof input.tenantId !== 'string' || !input.tenantId.trim()) {
    throw new AppNotificationInputError('Powiadomienie bez firmy');
  }
  if (!isAppNotificationKind(input.kind)) throw new AppNotificationInputError(`Nieznany rodzaj powiadomienia: ${String(input.kind)}`);
  const objectKey = input.objectKey.trim();
  if (!objectKey || Array.from(objectKey).length > APP_NOTIFICATION_LIMITS.objectKey) {
    throw new AppNotificationInputError('Powiadomienie bez poprawnego klucza obiektu');
  }
  const title = clip(input.title, APP_NOTIFICATION_LIMITS.title);
  if (!title) throw new AppNotificationInputError('Powiadomienie bez tytułu');
  const body = input.body?.trim() ? clip(input.body, APP_NOTIFICATION_LIMITS.body) : null;
  const link = input.link ?? null;
  if (link !== null && !isAppNotificationLink(link)) {
    throw new AppNotificationInputError('Link powiadomienia spoza aplikacji');
  }
  return { tenantId: input.tenantId, kind: input.kind, objectKey, title, body, link };
}

/** Ścisły zapis: liczba nowych wpisów; rzuca przy złym wpisie albo błędzie bazy. */
export async function writeAppNotification(input: AppNotificationInput, db: Db = createAdminClient()): Promise<number> {
  const w = prepare(input);
  const { data, error } = await db.rpc('app_notification_publish', {
    p_tenant_id: w.tenantId,
    p_kind: w.kind,
    p_object_key: w.objectKey,
    p_title: w.title,
    p_body: w.body,
    p_link: w.link,
  });
  if (error) throw new Error(`Zapis powiadomienia w aplikacji nieudany: ${error.message}`);
  const created = Number(data ?? 0);
  return Number.isFinite(created) ? created : 0;
}

export type PublishAppNotificationResult =
  | { ok: true; created: number }
  | { ok: false; reason: 'invalid' | 'write-failed'; error: string };

const defaultLogger = createJobLogger('app-notifications');

/**
 * Fail-open: zapis w dzwonku jako dodatek do joba. Nigdy nie rzuca; błąd
 * (także brak tabeli przed wgraniem 00188) idzie do logu i Sentry.
 */
export async function publishAppNotification(
  input: AppNotificationInput,
  opts: { db?: Db; logger?: JobLogger } = {},
): Promise<PublishAppNotificationResult> {
  const logger = opts.logger ?? defaultLogger;
  try {
    return { ok: true, created: await writeAppNotification(input, opts.db) };
  } catch (error) {
    const reason = error instanceof AppNotificationInputError ? 'invalid' : 'write-failed';
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('Dzwonek: zapis powiadomienia nieudany, job działa dalej', {
      tenantId: input.tenantId,
      kind: input.kind,
      objectKey: input.objectKey,
      reason,
      error: message,
    });
    Sentry.captureException(error, {
      tags: { area: 'app-notifications', kind: input.kind, reason },
      extra: { tenantId: input.tenantId, objectKey: input.objectKey },
    });
    return { ok: false, reason, error: message };
  }
}
