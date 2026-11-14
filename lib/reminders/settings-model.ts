import type { Database } from '@/types/database';

/**
 * Ustawienia przypomnień o zapłacie po odczycie z bazy: te same wartości
 * domyślne i granice dla formularza strony (`reminder-settings-form.tsx`) i
 * odczytu telefonu (`GET /api/mobile/v1/ustawienia`, M10b). Plik bez
 * `'use client'`, żeby serwer mógł go wołać.
 */

export type ReminderSettingsRow = Database['public']['Tables']['reminder_settings']['Row'] | null;

export interface ReminderSettings {
  enabled: boolean;
  stage_1_enabled: boolean;
  stage_1_days_after_due: number;
  stage_2_enabled: boolean;
  stage_2_days_after_due: number;
  stage_3_enabled: boolean;
  stage_3_days_after_due: number;
  sender_name: string | null;
  /**
   * Dawne „Adres From”. Nie trafia już do „Od:” (Resend wysyła tylko z domen
   * FaktWay) — służy jako Reply-To, gdy `reply_to_email` jest pusty. Pola nie
   * ma w formularzu; kolumna zostaje, bo część kont ma ją wypełnioną.
   */
  sender_email: string | null;
  reply_to_email: string | null;
  pause_on_reply: boolean;
  pause_on_partial_payment: boolean;
  send_on_weekdays_only: boolean;
  send_hour: number;
  max_reminders_per_invoice: number;
}

/** Propozycja formularza dla firmy bez zapisanych ustawień (bez wiersza scheduler niczego nie przygotowuje). */
export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
  enabled: true,
  stage_1_enabled: true,
  stage_1_days_after_due: 3,
  stage_2_enabled: true,
  stage_2_days_after_due: 7,
  stage_3_enabled: true,
  stage_3_days_after_due: 14,
  sender_name: null,
  sender_email: null,
  reply_to_email: null,
  pause_on_reply: true,
  pause_on_partial_payment: true,
  send_on_weekdays_only: true,
  send_hour: 9,
  max_reminders_per_invoice: 3,
};

export function reminderSettingsFromRow(row: ReminderSettingsRow, tenantName: string): ReminderSettings {
  const nameFallback = tenantName.trim() || null;
  if (!row) {
    return { ...DEFAULT_REMINDER_SETTINGS, sender_name: nameFallback };
  }
  return {
    enabled: row.enabled,
    stage_1_enabled: row.stage_1_enabled,
    stage_1_days_after_due: row.stage_1_days_after_due,
    stage_2_enabled: row.stage_2_enabled,
    stage_2_days_after_due: row.stage_2_days_after_due,
    stage_3_enabled: row.stage_3_enabled,
    stage_3_days_after_due: row.stage_3_days_after_due,
    sender_name:
      typeof row.sender_name === 'string' && row.sender_name.trim()
        ? row.sender_name.trim()
        : nameFallback,
    sender_email: row.sender_email?.trim() || null,
    reply_to_email: row.reply_to_email?.trim() || null,
    pause_on_reply: row.pause_on_reply,
    pause_on_partial_payment: row.pause_on_partial_payment,
    send_on_weekdays_only: row.send_on_weekdays_only,
    send_hour: Math.min(18, Math.max(6, row.send_hour ?? 9)),
    max_reminders_per_invoice: Math.min(
      20,
      Math.max(1, row.max_reminders_per_invoice ?? 3),
    ),
  };
}
