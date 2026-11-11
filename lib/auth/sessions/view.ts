import { z } from 'zod';

import { formatWarsawDateTime } from '@/lib/format/warsaw-date';

import { formatIpPrefix } from './ip-prefix';
import { describeUserAgent, type SessionDeviceKind } from './user-agent';

/**
 * Wiersze funkcji 00174 (`list_account_sessions`, `list_account_logins`)
 * i ich widok na stronie Ustawienia → Bezpieczeństwo (krok 8.5). Moduł bez
 * zależności serwerowych: używa go strona i komponent kliencki.
 */

export const UNKNOWN_DEVICE = 'Nieznane urządzenie';

const LOGIN_METHOD_LABELS: Record<string, string> = {
  password: 'hasło',
  passkey: 'biometria',
  google: 'konto Google',
  email_link: 'link z e-maila',
  signup: 'rejestracja',
};

const timestamp = z.string().min(1).nullable();

export const accountSessionRowSchema = z.object({
  session_id: z.string().uuid(),
  is_current: z.boolean(),
  signed_in_at: timestamp,
  last_active_at: timestamp,
  login_method: z.string().nullable(),
  user_agent: z.string().nullable(),
  ip_prefix: z.string().nullable(),
  device_source: z.enum(['login', 'session']),
});
export type AccountSessionRow = z.infer<typeof accountSessionRowSchema>;

export const accountLoginRowSchema = z.object({
  signed_in_at: z.string().min(1),
  action: z.string(),
  login_method: z.string().nullable(),
  user_agent: z.string().nullable(),
  ip_prefix: z.string().nullable(),
  session_id: z.string().uuid().nullable(),
  is_current: z.boolean(),
  is_active: z.boolean(),
});
export type AccountLoginRow = z.infer<typeof accountLoginRowSchema>;

export interface AccountSessionView {
  id: string;
  isCurrent: boolean;
  kind: SessionDeviceKind;
  /** „iPhone (Safari)” albo „Nieznane urządzenie”. */
  device: string;
  /** „83.21.104.x”; `null`, gdy adresu nie znamy albo to adres serwera FaktWay. */
  ip: string | null;
  /** „hasło”, „biometria”…; `null`, gdy sposobu logowania nie znamy. */
  method: string | null;
  signedInAt: string | null;
  lastActiveAt: string | null;
  /**
   * Ostatnia aktywność starsza niż limit sesji (30 dni, `GOTRUE_SESSIONS_INACTIVITY_TIMEOUT`).
   * GoTrue odrzuci taką sesję przy następnym użyciu albo odświeżeniu; do tego czasu wiersz
   * jeszcze jest w `auth.sessions`. Bieżąca sesja nigdy: właśnie jej używamy.
   */
  inactiveOver30Days: boolean;
}

export type AccountLoginStatus = 'current' | 'active' | 'ended' | 'unknown';

export interface AccountLoginView {
  key: string;
  when: string;
  kind: SessionDeviceKind;
  device: string;
  ip: string | null;
  method: string | null;
  /**
   * `current`: to logowanie dało tę sesję; `active`: nadal zalogowane; `ended`: sesja
   * zakończona; `unknown`: wpis sprzed kroku 8.5, bez identyfikatora sesji.
   */
  status: AccountLoginStatus;
}

function loginMethodLabel(method: string | null): string | null {
  return method ? (LOGIN_METHOD_LABELS[method] ?? null) : null;
}

function formatted(value: string | null): string | null {
  return value ? formatWarsawDateTime(value) : null;
}

/** Urządzenie i adres. Zapytanie serwera FaktWay nie jest urządzeniem, a jego adres to adres serwera. */
function deviceAndIp(userAgent: string | null, ipPrefix: string | null) {
  const device = describeUserAgent(userAgent);
  return {
    kind: device.kind,
    device: device.label ?? UNKNOWN_DEVICE,
    ip: device.fromServer ? null : formatIpPrefix(ipPrefix),
  };
}

/** Nagłówki bieżącego żądania: to jest urządzenie, z którego klient patrzy na listę. */
export interface CurrentRequestDevice {
  userAgent: string | null;
  ip: string | null;
}

/**
 * Bieżąca sesja bez wpisu logowania (zalogowana przed krokiem 8.5) bierze urządzenie
 * z bieżącego żądania: to na pewno to urządzenie, a GoTrue zna tylko serwer FaktWay.
 */
const SESSION_INACTIVITY_LIMIT_MS = 30 * 24 * 60 * 60 * 1000;

export function toAccountSessionView(row: AccountSessionRow, current?: CurrentRequestDevice, now: Date = new Date()): AccountSessionView {
  const lastActiveMs = row.last_active_at ? Date.parse(row.last_active_at) : Number.NaN;
  const fromRequest = row.is_current && row.device_source === 'session' && current;
  return {
    id: row.session_id,
    isCurrent: row.is_current,
    ...(fromRequest ? deviceAndIp(current.userAgent, current.ip) : deviceAndIp(row.user_agent, row.ip_prefix)),
    method: loginMethodLabel(row.login_method),
    signedInAt: formatted(row.signed_in_at),
    lastActiveAt: formatted(row.last_active_at),
    inactiveOver30Days: !row.is_current && now.getTime() - lastActiveMs > SESSION_INACTIVITY_LIMIT_MS,
  };
}

export function toAccountLoginView(row: AccountLoginRow, index: number): AccountLoginView {
  let status: AccountLoginStatus = 'unknown';
  if (row.is_current) status = 'current';
  else if (row.is_active) status = 'active';
  else if (row.session_id) status = 'ended';
  return {
    key: `${index}:${row.signed_in_at}`,
    when: formatWarsawDateTime(row.signed_in_at),
    ...deviceAndIp(row.user_agent, row.ip_prefix),
    method: loginMethodLabel(row.login_method),
    status,
  };
}
