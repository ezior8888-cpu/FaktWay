import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { headers } from 'next/headers';
import { z } from 'zod';

import { getClientIp } from '@/lib/auth/get-client-ip';

import {
  accountLoginRowSchema,
  accountSessionRowSchema,
  toAccountLoginView,
  toAccountSessionView,
  type AccountLoginView,
  type AccountSessionView,
  type CurrentRequestDevice,
} from './view';

/**
 * Odczyt listy urządzeń i historii logowań klientem z sesji (krok 8.5).
 * Funkcje 00174 same pilnują, że to własne konto, że sesja z tokenu wciąż
 * istnieje i że przy 2FA podano kod; tu tylko tłumaczymy odpowiedź na stan
 * ekranu. Niczego nie rzucamy: strona ustawień ma się wyrenderować zawsze.
 */

export type AccountSecurityLoad<T> =
  | { status: 'ok'; items: T[] }
  | { status: 'code_required' }
  | { status: 'failed' };

export interface AccountSecurityRpcError {
  code?: string | null;
  message?: string | null;
}

type RpcClient = Pick<SupabaseClient, 'rpc'>;

/** Odmowy z 00174 (`RAISE EXCEPTION '<kod>'`) jako kody akcji i ekranu. */
export type AccountSecurityRefusal = 'code_step_required' | 'session_not_found' | 'current_session' | 'other';

export function accountSecurityRefusal(error: AccountSecurityRpcError): AccountSecurityRefusal {
  switch (error.message) {
    case 'code_step_required': return 'code_step_required';
    case 'session_not_found':
    case 'not_authenticated': return 'session_not_found';
    case 'current_session': return 'current_session';
    default: return 'other';
  }
}

/**
 * Nazwy funkcji zostają dosłowne w wywołaniach `.rpc('…')` niżej: po nich
 * `db-rpc-signatures.test.ts` sprawdza, że funkcja i argumenty istnieją w migracjach.
 */
async function load<Row, View>(
  name: string,
  call: () => PromiseLike<{ data: unknown; error: AccountSecurityRpcError | null }>,
  schema: z.ZodType<Row>,
  toView: (row: Row, index: number) => View,
): Promise<AccountSecurityLoad<View>> {
  try {
    const { data, error } = await call();
    if (error) return accountSecurityRefusal(error) === 'code_step_required' ? { status: 'code_required' } : { status: 'failed' };
    const rows = z.array(schema).safeParse(data);
    if (!rows.success) {
      console.error(`[sesje] ${name}: nieoczekiwany kształt odpowiedzi`);
      return { status: 'failed' };
    }
    return { status: 'ok', items: rows.data.map(toView) };
  } catch {
    return { status: 'failed' };
  }
}

export function loadAccountSessions(
  supabase: RpcClient,
  current?: CurrentRequestDevice,
): Promise<AccountSecurityLoad<AccountSessionView>> {
  return load(
    'list_account_sessions',
    () => supabase.rpc('list_account_sessions'),
    accountSessionRowSchema,
    (row) => toAccountSessionView(row, current),
  );
}

/**
 * Urządzenie bieżącego żądania: przeglądarka z nagłówka i adres w tej samej
 * kolejności co limity prób (`getClientIp`: najpierw `X-Real-Ip` od Traefika).
 * Poza żądaniem (testy, render bez nagłówków) nic nie wiemy i nic nie zgadujemy.
 */
export async function readCurrentRequestDevice(): Promise<CurrentRequestDevice | undefined> {
  try {
    const userAgent = (await headers()).get('user-agent');
    const ip = await getClientIp();
    return { userAgent, ip: ip === 'unknown' ? null : ip };
  } catch {
    return undefined;
  }
}

/** Najwyżej 50 wpisów (granica w 00174). */
export function loadAccountLogins(supabase: RpcClient, limit = 20): Promise<AccountSecurityLoad<AccountLoginView>> {
  return load(
    'list_account_logins',
    () => supabase.rpc('list_account_logins', { p_limit: limit }),
    accountLoginRowSchema,
    toAccountLoginView,
  );
}
