'use client';

import { useState, useTransition } from 'react';
import { RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import {
  type ReminderSettingsPayload,
  updateReminderSettingsAction,
} from '@/app/actions/reminders';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import type { Database } from '@/types/database';

type SettingsRow = Database['public']['Tables']['reminder_settings']['Row'] | null;

export interface Settings {
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

interface Props {
  initialSettings: SettingsRow;
  tenantName: string;
}

const DEFAULT_SETTINGS: Settings = {
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

function rowToSettings(row: SettingsRow, tenantName: string): Settings {
  const nameFallback = tenantName.trim() || null;
  if (!row) {
    return { ...DEFAULT_SETTINGS, sender_name: nameFallback };
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

function toPayload(s: Settings): ReminderSettingsPayload {
  const days = (n: number) => Math.min(90, Math.max(1, n));
  return {
    enabled: s.enabled,
    stage_1_enabled: s.stage_1_enabled,
    stage_1_days_after_due: days(s.stage_1_days_after_due),
    stage_2_enabled: s.stage_2_enabled,
    stage_2_days_after_due: days(s.stage_2_days_after_due),
    stage_3_enabled: s.stage_3_enabled,
    stage_3_days_after_due: days(s.stage_3_days_after_due),
    sender_name: s.sender_name?.trim() || null,
    sender_email: s.sender_email?.trim() || null,
    reply_to_email: s.reply_to_email?.trim() || null,
    pause_on_reply: s.pause_on_reply,
    pause_on_partial_payment: s.pause_on_partial_payment,
    send_on_weekdays_only: s.send_on_weekdays_only,
    send_hour: Math.min(18, Math.max(6, s.send_hour)),
    max_reminders_per_invoice: Math.min(
      20,
      Math.max(1, s.max_reminders_per_invoice),
    ),
  };
}

const STAGE_META = [
  {
    enabled: 'stage_1_enabled',
    days: 'stage_1_days_after_due',
    name: 'Etap 1: Uprzejme przypomnienie',
    desc: 'Wczesne, miłe pytanie',
  },
  {
    enabled: 'stage_2_enabled',
    days: 'stage_2_days_after_due',
    name: 'Etap 2: Stanowcze przypomnienie',
    desc: 'Bardziej formalne wezwanie',
  },
  {
    enabled: 'stage_3_enabled',
    days: 'stage_3_days_after_due',
    name: 'Etap 3: Przedsądowe wezwanie',
    desc: 'Z PDF, ostrzeżenie o sądzie',
  },
] as const;

export function ReminderSettingsForm({
  initialSettings,
  tenantName,
}: Props) {
  const [settings, setSettings] = useState<Settings>(() =>
    rowToSettings(initialSettings, tenantName),
  );
  const [isSaving, startSave] = useTransition();

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = () => {
    startSave(async () => {
      const result = await updateReminderSettingsAction(toPayload(settings));
      if (result.success) {
        toast.success('Ustawienia zapisane');
      } else {
        toast.error(result.error ?? 'Błąd zapisu');
      }
    });
  };

  const parseBoundedInt = (raw: string, fallback: number, min: number, max: number) => {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };

  // Wygląd z Finory: przełączniki jak `notifications/quiet-hours-card.tsx`
  // i `security-preferences-card.tsx`, pola liczbowe jak wiersze
  // `general/index.tsx` (etykieta i opis po lewej, pole po prawej), sekcje
  // rozdzielone `Separator`, zapis pod spodem jak w `change-password-card.tsx`.
  return (
    <FieldGroup>
      <Field orientation="horizontal" className="items-center!">
        <FieldContent>
          <FieldLabel htmlFor="reminders-enabled">
            {settings.enabled ? 'Flo pilnuje terminów' : 'Flo nie pilnuje terminów'}
          </FieldLabel>
          <FieldDescription>
            {settings.enabled
              ? 'Po terminie przygotuję ponaglenie i pokażę Ci je do zatwierdzenia'
              : 'Nie odezwę się w sprawie przeterminowanych faktur'}
          </FieldDescription>
          <FieldDescription>
            Flo przygotowuje ponaglenia do przeterminowanych faktur. Wysyłasz je
            Ty, jednym kliknięciem — nic nie wychodzi automatycznie.
          </FieldDescription>
        </FieldContent>
        <Switch
          id="reminders-enabled"
          checked={settings.enabled}
          onCheckedChange={(v) => update('enabled', v)}
        />
      </Field>

      <Separator />

      <div>
        <FieldLabel>Etapy przypomnień</FieldLabel>
        <FieldDescription>Skonfiguruj kiedy i jakie przypomnienia wysyłać</FieldDescription>
      </div>

      {STAGE_META.map((meta, idx) => (
        <div
          key={meta.enabled}
          className="flex flex-col gap-3 border p-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <Field orientation="horizontal" className="items-center! sm:w-auto sm:flex-1">
            <Switch
              id={`stage-${idx}`}
              checked={settings[meta.enabled]}
              onCheckedChange={(v) => update(meta.enabled, v)}
            />
            <FieldContent>
              <FieldLabel htmlFor={`stage-${idx}`}>{meta.name}</FieldLabel>
              <FieldDescription>{meta.desc}</FieldDescription>
            </FieldContent>
          </Field>
          <div className="flex shrink-0 items-center gap-2">
            <FieldLabel htmlFor={`days-${idx}`} className="text-muted-foreground text-xs font-normal whitespace-nowrap">
              Dni po terminie:
            </FieldLabel>
            <Input
              id={`days-${idx}`}
              type="number"
              min={1}
              max={90}
              value={settings[meta.days]}
              onChange={(e) =>
                update(
                  meta.days,
                  parseBoundedInt(e.target.value, settings[meta.days], 1, 90),
                )
              }
              className="w-20"
              disabled={!settings[meta.enabled]}
            />
          </div>
        </div>
      ))}

      <Separator />

      <div>
        <FieldLabel>Inteligentne reguły</FieldLabel>
        <FieldDescription>Anti-spam i smart pauzy</FieldDescription>
      </div>

      <SmartToggle
        id="pause-on-reply"
        label="Pauza po odpowiedzi klienta"
        desc="Wstrzymaj przypomnienia jeśli klient odpisał na email"
        checked={settings.pause_on_reply}
        onChange={(v) => update('pause_on_reply', v)}
      />

      <SmartToggle
        id="pause-on-partial-payment"
        label="Pauza po częściowej płatności"
        desc="Wstrzymaj jeśli klient zapłacił choć część (negocjacja w toku)"
        checked={settings.pause_on_partial_payment}
        onChange={(v) => update('pause_on_partial_payment', v)}
      />

      <SmartToggle
        id="send-on-weekdays-only"
        label="Wysyłaj tylko w dni robocze"
        desc="Pomijaj soboty i niedziele"
        checked={settings.send_on_weekdays_only}
        onChange={(v) => update('send_on_weekdays_only', v)}
      />

      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel htmlFor="send-hour">Godzina wysyłki</FieldLabel>
          <FieldDescription>Najlepiej rano przed godzinami pracy (6–18)</FieldDescription>
        </FieldContent>
        <Input
          id="send-hour"
          type="number"
          min={6}
          max={18}
          value={settings.send_hour}
          onChange={(e) =>
            update(
              'send_hour',
              parseBoundedInt(e.target.value, settings.send_hour, 6, 18),
            )
          }
          className="w-full sm:w-64"
        />
      </Field>

      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel htmlFor="max-reminders">Maks. przypomnień na fakturę</FieldLabel>
          <FieldDescription>Limit etapów w kolejce (scheduler)</FieldDescription>
        </FieldContent>
        <Input
          id="max-reminders"
          type="number"
          min={1}
          max={20}
          value={settings.max_reminders_per_invoice}
          onChange={(e) =>
            update(
              'max_reminders_per_invoice',
              parseBoundedInt(
                e.target.value,
                settings.max_reminders_per_invoice,
                1,
                20,
              ),
            )
          }
          className="w-full sm:w-64"
        />
      </Field>

      <Separator />

      <div>
        <FieldLabel>Dane nadawcy</FieldLabel>
        <FieldDescription>
          Nazwa pojawi się w stopce emaila i jako „Od:”. Wysyłamy z adresu
          FaktWay w imieniu Twojej firmy — odpowiedzi klientów trafią na
          adres poniżej.
        </FieldDescription>
      </div>

      <Field orientation="responsive" className="flex-col!">
        <FieldContent>
          <FieldLabel htmlFor="sender-name">Imię i nazwisko / nazwa nadawcy</FieldLabel>
        </FieldContent>
        <div className="w-full!">
          <Input
            id="sender-name"
            value={settings.sender_name ?? ''}
            onChange={(e) =>
              update(
                'sender_name',
                e.target.value === '' ? null : e.target.value,
              )
            }
            placeholder={tenantName}
          />
        </div>
      </Field>

      <Field orientation="responsive" className="flex-col!">
        <FieldContent>
          <FieldLabel htmlFor="reply-to">Email do odpowiedzi (Reply-To)</FieldLabel>
          <FieldDescription>Klient odpisuje tu, nie na nasz email systemowy</FieldDescription>
        </FieldContent>
        <div className="w-full!">
          <Input
            id="reply-to"
            type="email"
            autoComplete="off"
            value={settings.reply_to_email ?? ''}
            onChange={(e) =>
              update(
                'reply_to_email',
                e.target.value === '' ? null : e.target.value,
              )
            }
            placeholder="kontakt@twoja-firma.pl"
          />
        </div>
      </Field>

      <Separator />

      <div>
        <Button type="button" onClick={handleSave} disabled={isSaving}>
          {isSaving ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
          Zapisz ustawienia
        </Button>
      </div>
    </FieldGroup>
  );
}

function SmartToggle({
  id,
  label,
  desc,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Field orientation="horizontal" className="items-center!">
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <FieldDescription>{desc}</FieldDescription>
      </FieldContent>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </Field>
  );
}
