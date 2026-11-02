'use client';

import { useState, useTransition } from 'react';

import { useRouter } from 'next/navigation';
import {
  RiCloseLine,
  RiFileTextLine,
  RiLoader4Line,
  RiMailLine,
  RiSendPlaneLine,
} from '@remixicon/react';
import { toast } from 'sonner';

import {
  triggerCoPilotNowAction,
  updateAccountantSettingsAction,
} from '@/app/actions/exports';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { exportScopeFor, UnknownExportFormatError } from '@/lib/exports/export-scope';
import { isExportFormatSuspended } from '@/lib/exports/suspended-formats';
import { plural } from '@/lib/i18n/plural';
import { cn } from '@/lib/utils';
import type { Tables } from '@/types/database';

type SettingsRow = Tables<'accountant_settings'>;

export type ExportJobPreviewRow = Pick<
  Tables<'export_jobs'>,
  | 'id'
  | 'format'
  | 'status'
  | 'period_start'
  | 'period_end'
  | 'created_at'
  | 'invoices_count'
  | 'emailed_at'
>;

export type CoPilotSettingsFormProps = {
  initialSettings: SettingsRow | null;
  recentJobs: ExportJobPreviewRow[];
};

type ExportFormat = Tables<'export_jobs'>['format'];

const FORMAT_OPTIONS: {
  value: ExportFormat;
  label: string;
  desc: string;
}[] = [
  { value: 'jpk_fa', label: 'JPK_FA(4)', desc: 'Oficjalny format MF do US' },
  {
    value: 'kpir_excel',
    label: 'KPiR Excel',
    desc: 'Książka Przychodów i Rozchodów',
  },
  {
    value: 'comarch_optima',
    label: 'Comarch Optima',
    desc: 'XML do programu Optima',
  },
  {
    value: 'insert_subiekt',
    label: 'Insert Subiekt',
    desc: 'CSV dla Insert Subiekt',
  },
  {
    value: 'symfonia',
    label: 'Symfonia',
    desc: 'CSV dla Symfonii',
  },
  { value: 'wapro', label: 'Wapro Mag', desc: 'CSV dla Wapro Mag' },
  {
    value: 'csv_universal',
    label: 'CSV uniwersalny',
    desc: 'Ogólny eksport CSV',
  },
];

/**
 * Do wyboru tylko formaty, które działają — wstrzymany (np. Comarch Optima,
 * `suspended-formats.ts`) znika z listy, a zapisany wcześniej wybór nie
 * wraca na formularz. Paczka i tak zamienia go na CSV (`parseFormats`).
 */
const SELECTABLE_OPTIONS = FORMAT_OPTIONS.filter((o) => !isExportFormatSuspended(o.value));

const ALLOWED_VALUES = new Set(SELECTABLE_OPTIONS.map((o) => o.value));

function normalizePreferredFormats(fromDb: unknown): ExportFormat[] {
  const arr = Array.isArray(fromDb) ? fromDb : [];
  const picked = [...new Set(arr.filter((v): v is ExportFormat =>
    typeof v === 'string' && ALLOWED_VALUES.has(v as ExportFormat)))];
  return picked.length > 0 ? picked : ['jpk_fa', 'kpir_excel'];
}

export function CoPilotSettingsForm({
  initialSettings,
  recentJobs,
}: CoPilotSettingsFormProps) {
  const router = useRouter();
  const [settings, setSettings] = useState(() => ({
    co_pilot_enabled: initialSettings?.co_pilot_enabled ?? false,
    accountant_email: initialSettings?.accountant_email ?? '',
    accountant_name: initialSettings?.accountant_name ?? '',
    accountant_company: initialSettings?.accountant_company ?? '',
    preferred_formats:
      normalizePreferredFormats(initialSettings?.preferred_formats ?? null),
    send_day_of_month: initialSettings?.send_day_of_month ?? 5,
    include_issued_invoices:
      initialSettings?.include_issued_invoices ?? true,
    include_received_invoices:
      initialSettings?.include_received_invoices ?? true,
    include_corrections: initialSettings?.include_corrections ?? true,
    cc_emails: (initialSettings?.cc_emails ?? []).filter(
      (e): e is string => typeof e === 'string' && e.includes('@'),
    ),
  }));

  const [isSaving, startSave] = useTransition();
  const [isTriggering, startTrigger] = useTransition();

  const saveDisabled = isSaving;
  const triggerDisabled =
    isTriggering ||
    !settings.co_pilot_enabled ||
    !settings.accountant_email.trim();

  const handleSave = () => {
    startSave(async () => {
      const result = await updateAccountantSettingsAction({
        co_pilot_enabled: settings.co_pilot_enabled,
        accountant_email: settings.accountant_email,
        accountant_name: settings.accountant_name,
        accountant_company: settings.accountant_company.trim()
          ? settings.accountant_company.trim()
          : undefined,
        preferred_formats: settings.preferred_formats,
        send_day_of_month: settings.send_day_of_month,
        include_issued_invoices: settings.include_issued_invoices,
        include_received_invoices: settings.include_received_invoices,
        include_corrections: settings.include_corrections,
        cc_emails:
          settings.cc_emails.length > 0 ? settings.cc_emails : undefined,
      });
      if (result.success) {
        toast.success('Ustawienia zapisane');
        router.refresh();
      } else {
        toast.error(result.error ?? 'Błąd zapisu');
      }
    });
  };

  const handleTriggerNow = () => {
    if (!settings.co_pilot_enabled || !settings.accountant_email.trim()) {
      toast.error('Najpierw skonfiguruj księgowego i włącz Co-Pilota');
      return;
    }

    startTrigger(async () => {
      // `triggerCoPilotNowAction` czyta ustawienia z bazy — bez zapisu
      // przełącznik/email w UI nie trafiały do DB i ręczne wysłanie kończyło się błędem.
      const saveResult = await updateAccountantSettingsAction({
        co_pilot_enabled: settings.co_pilot_enabled,
        accountant_email: settings.accountant_email,
        accountant_name: settings.accountant_name,
        accountant_company: settings.accountant_company.trim()
          ? settings.accountant_company.trim()
          : undefined,
        preferred_formats: settings.preferred_formats,
        send_day_of_month: settings.send_day_of_month,
        include_issued_invoices: settings.include_issued_invoices,
        include_received_invoices: settings.include_received_invoices,
        include_corrections: settings.include_corrections,
        cc_emails:
          settings.cc_emails.length > 0 ? settings.cc_emails : undefined,
      });
      if (!saveResult.success) {
        toast.error(saveResult.error ?? 'Nie udało się zapisać ustawień');
        return;
      }

      const today = new Date();
      const previousMonth = new Date(
        today.getFullYear(),
        today.getMonth() - 1,
        1,
      );
      const result = await triggerCoPilotNowAction(
        previousMonth.getMonth() + 1,
        previousMonth.getFullYear(),
      );
      if (result.success) {
        toast.success(
          'Paczka jest generowana w tle — email pójdzie za chwilę',
        );
        router.refresh();
      } else {
        toast.error(result.error ?? 'Błąd');
      }
    });
  };

  const toggleFormat = (format: ExportFormat) => {
    setSettings((prev) => ({
      ...prev,
      preferred_formats: prev.preferred_formats.includes(format)
        ? prev.preferred_formats.filter((f) => f !== format)
        : [...prev.preferred_formats, format],
    }));
  };

  // Wygląd z Finory: przełącznik jak `security-preferences-card.tsx`, pola
  // jak `change-password-card.tsx`, wybór formatów jak karty wyboru
  // z `two-factor-setup-dialog.tsx` (z `Checkbox` zamiast `RadioGroupItem`,
  // bo formatów może być kilka), lista paczek jak `sessions-card.tsx`;
  // sekcje rozdzielone `Separator`, przyciski pod spodem.
  return (
    <FieldGroup>
      <Field orientation="horizontal" className="items-center!">
        <FieldContent>
          <FieldLabel htmlFor="co-pilot-enabled">
            {settings.co_pilot_enabled ? 'Co-Pilot aktywny' : 'Co-Pilot wyłączony'}
          </FieldLabel>
          <FieldDescription>
            {settings.co_pilot_enabled
              ? `Paczka wysyłana automatycznie ${settings.send_day_of_month}. dnia każdego miesiąca`
              : 'Włącz aby zacząć automatyczne wysyłki'}
          </FieldDescription>
          <FieldDescription>
            Automatycznie wysyłamy paczkę dokumentów księgowych do Twojego biura
            rachunkowego
          </FieldDescription>
        </FieldContent>
        <Switch
          id="co-pilot-enabled"
          checked={settings.co_pilot_enabled}
          onCheckedChange={(v) => setSettings((s) => ({ ...s, co_pilot_enabled: v }))}
          disabled={saveDisabled}
        />
      </Field>

      <Separator />

      <div>
        <FieldLabel>Dane księgowego</FieldLabel>
        <FieldDescription>Na ten adres lecą wszystkie paczki</FieldDescription>
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="co-pilot-accountant-name">Imię i nazwisko</FieldLabel>
          <Input
            id="co-pilot-accountant-name"
            value={settings.accountant_name}
            disabled={saveDisabled}
            onChange={(e) =>
              setSettings({ ...settings, accountant_name: e.target.value })
            }
            placeholder="Anna Kowalska"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="co-pilot-accountant-company">Nazwa biura (opcjonalnie)</FieldLabel>
          <Input
            id="co-pilot-accountant-company"
            value={settings.accountant_company}
            disabled={saveDisabled}
            onChange={(e) =>
              setSettings({
                ...settings,
                accountant_company: e.target.value,
              })
            }
            placeholder="Biuro Rachunkowe Kowalska"
          />
        </Field>
      </div>

      <Field>
        <FieldLabel htmlFor="co-pilot-accountant-email">Email księgowego</FieldLabel>
        <Input
          id="co-pilot-accountant-email"
          type="email"
          autoComplete="email"
          value={settings.accountant_email}
          disabled={saveDisabled}
          onChange={(e) =>
            setSettings({ ...settings, accountant_email: e.target.value })
          }
          placeholder="anna@biuro.pl"
        />
      </Field>

      <Separator />

      <div>
        <FieldLabel>Formaty plików</FieldLabel>
        <FieldDescription>Wybierz formaty zgodne z programem Twojego księgowego</FieldDescription>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {SELECTABLE_OPTIONS.map((opt) => {
          const selected = settings.preferred_formats.includes(opt.value);
          const id = `co-pilot-format-${opt.value}`;
          return (
            <div
              key={opt.value}
              className={cn(
                'border-input relative flex w-full gap-3 rounded-lg border p-3',
                selected && 'border-primary/50 bg-primary/10',
              )}
            >
              <Checkbox
                id={id}
                checked={selected}
                disabled={saveDisabled}
                onCheckedChange={() => toggleFormat(opt.value)}
                className="mt-0.5"
              />
              <div className="grid grow gap-1">
                <FieldLabel htmlFor={id} className="gap-2 text-sm after:absolute after:inset-0">
                  <RiFileTextLine className="size-5" aria-hidden />
                  {opt.label}
                </FieldLabel>
                {/* WCAG 1.4.3: muted-foreground na zaznaczonym kafelku (primary/10) daje 4,23:1. */}
                <p className={cn('text-xs', selected ? 'text-accent-foreground' : 'text-muted-foreground')}>{opt.desc}</p>
              </div>
            </div>
          );
        })}
      </div>

      <Separator />

      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel htmlFor="co-pilot-send-day">Harmonogram</FieldLabel>
          <FieldDescription>Kiedy wysyłać paczkę z poprzedniego miesiąca</FieldDescription>
        </FieldContent>
        <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
          <span className="text-muted-foreground text-sm">Wysyłaj</span>
          <Input
            id="co-pilot-send-day"
            type="number"
            min={1}
            max={28}
            disabled={saveDisabled}
            value={settings.send_day_of_month}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              setSettings({
                ...settings,
                send_day_of_month: Number.isNaN(n) ? 5 : n,
              });
            }}
            className="w-20 text-center"
          />
          <span className="text-muted-foreground text-sm whitespace-nowrap">dnia każdego miesiąca o 8:00</span>
        </div>
      </Field>

      <Alert role="note">
        <AlertDescription>
          <strong>Przykład:</strong> jeśli wybierzesz 5. dzień, to{' '}
          <strong>5 maja</strong> wyślemy paczkę za <strong>kwiecień</strong>.{' '}
          Domyślnie ustawione na 5 — daje Ci to bufor na ostatnie korekty na koniec miesiąca.
        </AlertDescription>
      </Alert>

      <Separator />

      <div>
        <FieldLabel>Co dołączać do paczki</FieldLabel>
        {/* FIR-01: reguła formatu z `lib/exports/export-scope.ts` — pola nie okrajają KPiR. */}
        <FieldDescription>
          KPiR zawsze ma całą sprzedaż (z zaliczkami, rozliczeniami i korektami) i koszty, a JPK_FA — tylko
          faktury wystawione. Pola niżej dotyczą pliku CSV i JPK_FA. Bez „Faktur korygujących” oba pliki mają
          tylko zwykłe faktury, bez zaliczek i rozliczeń.
        </FieldDescription>
      </div>

      <CheckboxRow
        id="co-pilot-include-issued"
        label="Faktury wystawione (sprzedażowe)"
        desc="Twoja sprzedaż — faktury które wystawiasz klientom"
        checked={settings.include_issued_invoices}
        disabled={saveDisabled}
        onChange={(v) =>
          setSettings({ ...settings, include_issued_invoices: v })
        }
      />

      <CheckboxRow
        id="co-pilot-include-received"
        label="Faktury otrzymane (zakupowe)"
        desc="Faktury kosztowe pobrane z inboxa KSeF"
        checked={settings.include_received_invoices}
        disabled={saveDisabled}
        onChange={(v) =>
          setSettings({ ...settings, include_received_invoices: v })
        }
      />

      <CheckboxRow
        id="co-pilot-include-corrections"
        label="Faktury korygujące"
        desc="Korekty wystawione i otrzymane w okresie"
        checked={settings.include_corrections}
        disabled={saveDisabled}
        onChange={(v) => setSettings({ ...settings, include_corrections: v })}
      />

      <Separator />

      <Field>
        <FieldContent>
          <FieldLabel htmlFor="co-pilot-cc">Kopia do innych</FieldLabel>
          <FieldDescription>
            Dodatkowe adresy które dostają paczkę (np. Twój własny email do
            archiwum)
          </FieldDescription>
        </FieldContent>
        <CcEmailsInput
          emails={settings.cc_emails}
          disabled={saveDisabled}
          onChange={(emails) => setSettings({ ...settings, cc_emails: emails })}
        />
      </Field>

      {recentJobs.length > 0 ? (
        <>
          <Separator />
          <div className="flex flex-col gap-4">
            <div>
              <FieldLabel>Ostatnie paczki</FieldLabel>
              <FieldDescription>Historia 5 ostatnich automatycznych wysyłek</FieldDescription>
            </div>

            <div className="flex flex-col gap-3">
              {recentJobs.map((job) => (
                <RecentJobRow key={job.id} job={job} />
              ))}
            </div>
          </div>
        </>
      ) : null}

      <Separator />

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={handleSave} disabled={saveDisabled}>
          {isSaving ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
          Zapisz ustawienia
        </Button>
        <Button
          variant="outline"
          type="button"
          onClick={handleTriggerNow}
          disabled={triggerDisabled}
        >
          {isTriggering ? <RiLoader4Line className="animate-spin" aria-hidden /> : <RiSendPlaneLine aria-hidden />}
          Wyślij teraz (za poprzedni miesiąc)
        </Button>
      </div>
    </FieldGroup>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

function CheckboxRow({
  id,
  label,
  desc,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  desc: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Field orientation="horizontal">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onChange(v)}
      />
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <FieldDescription>{desc}</FieldDescription>
      </FieldContent>
    </Field>
  );
}

function CcEmailsInput({
  emails,
  onChange,
  disabled,
}: {
  emails: string[];
  onChange: (emails: string[]) => void;
  disabled?: boolean;
}) {
  const [input, setInput] = useState('');

  const handleAdd = () => {
    const email = input.trim();
    if (!email) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast.error('Nieprawidłowy email');
      return;
    }
    if (emails.includes(email)) {
      toast.error('Już dodany');
      return;
    }
    onChange([...emails, email]);
    setInput('');
  };

  const handleRemove = (email: string) => {
    onChange(emails.filter((e) => e !== email));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Input
          id="co-pilot-cc"
          type="email"
          value={input}
          disabled={disabled}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleAdd();
            }
          }}
          placeholder="dodaj@email.pl i naciśnij Enter"
        />
        <Button
          variant="outline"
          type="button"
          onClick={handleAdd}
          disabled={disabled || !input.trim()}
        >
          Dodaj
        </Button>
      </div>

      {emails.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {emails.map((email) => (
            <Badge key={email} variant="secondary" className="gap-1.5">
              <RiMailLine aria-hidden />
              {email}
              <button
                type="button"
                aria-label={`Usuń ${email}`}
                onClick={() => handleRemove(email)}
                disabled={disabled}
                className="text-muted-foreground hover:text-foreground ml-1 disabled:pointer-events-none"
              >
                <RiCloseLine className="size-3" aria-hidden />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const BADGE_OK = 'bg-green-600/10 text-green-700 dark:bg-green-400/10 dark:text-green-400';
const BADGE_ERROR = 'bg-red-600/10 text-red-600 dark:bg-red-400/10 dark:text-red-400';
const BADGE_WARN = 'bg-amber-600/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-400';

/**
 * Plik z kosztami (KPiR) bez liczby faktur: `invoices_count` liczy tylko
 * sprzedaż — jak w historii eksportów.
 */
function showsInvoiceCount(format: ExportJobPreviewRow['format']): boolean {
  try {
    return !exportScopeFor(format).includeExpenses;
  } catch (error) {
    // Format spoza reguły (baza przed kodem): licznik jak dawniej, bez wywracania strony.
    if (error instanceof UnknownExportFormatError) return true;
    throw error;
  }
}

function RecentJobRow({ job }: { job: ExportJobPreviewRow }) {
  const statusDefaults = {
    completed: { label: 'Wysłane', className: BADGE_OK },
    failed: { label: 'Błąd', className: BADGE_ERROR },
    generating: { label: 'Generowanie...', className: BADGE_WARN },
    pending: { label: 'Oczekuje', className: undefined },
    expired: { label: 'Wygasłe', className: undefined },
  } as const;

  const cfg: { label: string; className: string | undefined } =
    statusDefaults[job.status as keyof typeof statusDefaults] ?? {
      label: job.status,
      className: undefined,
    };

  const formatLabel =
    FORMAT_OPTIONS.find((o) => o.value === job.format)?.label ??
    job.format.toUpperCase().replaceAll('_', ' ');

  const periodLabel = job.period_start.slice(0, 7);
  const emailed = job.emailed_at
    ? formatDateTimePl(job.emailed_at)
    : null;

  return (
    <div className="flex items-center justify-between gap-3 border p-3">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="bg-muted flex size-10 shrink-0 items-center justify-center">
          <RiFileTextLine className="text-muted-foreground size-5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {formatLabel} • {periodLabel}
          </p>
          <p className="text-muted-foreground text-xs">
            {[
              showsInvoiceCount(job.format)
                ? `${job.invoices_count} ${plural(job.invoices_count ?? 0, ['faktura', 'faktury', 'faktur'])}`
                : null,
              emailed ? `wysłano ${emailed}` : null,
            ].filter(Boolean).join(' • ')}
          </p>
        </div>
      </div>
      <Badge variant={cfg.className ? 'default' : 'secondary'} className={cfg.className}>
        {cfg.label}
      </Badge>
    </div>
  );
}

function formatDateTimePl(iso: string): string {
  return new Date(iso).toLocaleString('pl-PL', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
