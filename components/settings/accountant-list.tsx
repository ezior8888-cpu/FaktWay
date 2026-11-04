'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  RiAddLine,
  RiCloseLine,
  RiFileCopyLine,
  RiLoader4Line,
  RiUserSettingsLine,
} from '@remixicon/react';
import { toast } from 'sonner';

import { MfaStepUpNotice } from '@/components/auth/mfa-step-up-notice';
import {
  createAccountantTokenAction,
  revokeAccountantTokenAction,
} from '@/components/settings/accountant-actions';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldLabel } from '@/components/ui/field';
import { formatSettingsDate } from '@/components/settings/finora/format-date';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { plural } from '@/lib/i18n/plural';

/**
 * Linki dla księgowej. Wygląd: `connected-accounts` z Finory — nagłówek
 * z przyciskiem po prawej, każdy dostęp jako wiersz instytucji
 * (`connected-institution-row.tsx`: ikona, nazwa z odznaką stanu, szczegóły,
 * akcja po prawej), pusty stan jak jej `Empty`. Tabela zniknęła, więc na
 * telefonie nic nie przewija się w bok.
 */

/** Row z serwera (bez pola `token`). */
export interface AccountantAccessPublicRow {
  id: string;
  accountant_name: string;
  accountant_email: string;
  access_level: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  use_count: number;
  created_at: string;
}

type AccountantAccess = AccountantAccessPublicRow;

const ACCESS_LEVEL_OPTIONS: { label: string; value: 'read_only' | 'download' }[] = [
  { label: 'Tylko podgląd', value: 'read_only' },
  { label: 'Podgląd + pobieranie XML', value: 'download' },
];

const BADGE_OK = 'bg-green-600/10 text-green-800 dark:bg-green-400/10 dark:text-green-400';
const BADGE_ERROR = 'bg-red-600/10 text-red-600 dark:bg-red-400/10 dark:text-red-400';

const plDate = formatSettingsDate;

export function AccountantAccessList({
  accesses,
}: {
  accesses: AccountantAccessPublicRow[];
}) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const activeCount = accesses.filter((a) => !a.revoked_at && new Date(a.expires_at) > new Date()).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-between gap-2 max-sm:flex-col sm:items-center">
        <div>
          <p className="text-sm font-medium">Udostępnione dostępy</p>
          <p className="text-muted-foreground text-xs">
            Aktywne tokeny: <span className="text-foreground font-medium">{activeCount}</span>
          </p>
        </div>
        <Button
          onClick={() => {
            setShowForm(true);
            setGeneratedUrl(null);
          }}
        >
          <RiAddLine aria-hidden />
          Nowy dostęp
        </Button>
      </div>

      {/* Wygenerowany URL po utworzeniu */}
      {generatedUrl && (
        <GeneratedTokenCard
          url={generatedUrl}
          onClose={() => setGeneratedUrl(null)}
        />
      )}

      {/* Formularz tworzenia */}
      {showForm && !generatedUrl && (
        <CreateTokenForm
          onSuccess={(url) => {
            setGeneratedUrl(url);
            setShowForm(false);
            router.refresh();
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {/* Lista tokenów */}
      {accesses.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <RiUserSettingsLine />
            </EmptyMedia>
            <EmptyTitle>Brak udostępnionych dostępów</EmptyTitle>
            <EmptyDescription>Utwórz pierwszy link dla księgowej aby udostępnić jej faktury</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {accesses.map((access) => (
            <AccessRow key={access.id} access={access} />
          ))}
        </div>
      )}
    </div>
  );
}

function CreateTokenForm({
  onSuccess,
  onCancel,
}: {
  onSuccess: (url: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [accessLevel, setAccessLevel] = useState<'read_only' | 'download'>(
    'read_only'
  );
  const [validForDays, setValidForDays] = useState('90');
  // Sesja po biometrii: link wymaga kodu, więc odmowa niesie przejście na ekran kodu.
  const [stepUp, setStepUp] = useState<string | null>(null);
  const [isCreating, startCreating] = useTransition();

  const handleSubmit = () => {
    if (!name || !email) {
      toast.error('Wypełnij wszystkie pola');
      return;
    }

    setStepUp(null);
    startCreating(async () => {
      const result = await createAccountantTokenAction({
        name,
        email,
        accessLevel,
        validForDays: Number(validForDays),
      });

      if (result.success) {
        toast.success('Dostęp utworzony');
        onSuccess(result.shareUrl);
      } else if (result.mfaStepUp) {
        setStepUp(result.error);
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <div className="flex flex-col gap-4 border p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Nowy dostęp dla księgowej</p>
          <p className="text-muted-foreground text-xs">Wygenerujemy link, który możesz wysłać emailem</p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onCancel} aria-label="Zamknij">
          <RiCloseLine aria-hidden />
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="acc-name">Imię i nazwisko / nazwa biura</FieldLabel>
          <Input
            id="acc-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Anna Kowalska"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="acc-email">Email</FieldLabel>
          <Input
            id="acc-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="anna@biuro.pl"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="acc-level">Poziom dostępu</FieldLabel>
          <Select
            items={ACCESS_LEVEL_OPTIONS}
            value={accessLevel}
            onValueChange={(value) => value && setAccessLevel(value as 'read_only' | 'download')}
          >
            <SelectTrigger id="acc-level" className="w-full">
              <SelectValue placeholder="Poziom dostępu" />
            </SelectTrigger>
            <SelectContent className="p-1" alignItemWithTrigger={false}>
              <SelectGroup>
                {ACCESS_LEVEL_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="acc-days">Ważność (dni)</FieldLabel>
          <Input
            id="acc-days"
            type="number"
            min="1"
            max="365"
            value={validForDays}
            onChange={(e) => setValidForDays(e.target.value)}
          />
        </Field>
      </div>

      {stepUp ? (
        <MfaStepUpNotice returnTo="/settings/accountant">
          {stepUp} Po potwierdzeniu wrócisz tutaj.
        </MfaStepUpNotice>
      ) : null}

      <div className="flex gap-3 sm:justify-end">
        <Button variant="outline" onClick={onCancel} disabled={isCreating}>
          Anuluj
        </Button>
        <Button onClick={handleSubmit} disabled={isCreating}>
          {isCreating && <RiLoader4Line className="animate-spin" aria-hidden />}
          Wygeneruj link
        </Button>
      </div>
    </div>
  );
}

function GeneratedTokenCard({
  url,
  onClose,
}: {
  url: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    toast.success('Link skopiowany do schowka');
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Alert
      role="status"
      className="border-none bg-green-600/10 text-green-800 dark:bg-green-400/10 dark:text-green-400"
    >
      <AlertTitle>Link wygenerowany pomyślnie</AlertTitle>
      <AlertDescription className="flex flex-col gap-3 text-green-800 dark:text-green-400/80">
        <div className="flex items-start justify-between gap-3">
          <span>Skopiuj poniższy URL i wyślij emailem do księgowej</span>
          <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Zamknij">
            <RiCloseLine aria-hidden />
          </Button>
        </div>
        <div className="flex gap-2">
          <Input
            readOnly
            value={url}
            aria-label="Link dla księgowej"
            className="text-foreground font-mono text-xs"
            onClick={(e) => (e.target as HTMLInputElement).select()}
          />
          <Button onClick={handleCopy} className="shrink-0">
            <RiFileCopyLine aria-hidden />
            {copied ? 'Skopiowano!' : 'Kopiuj'}
          </Button>
        </div>
        <span>
          Link jest jednorazowy do pokazania. Po zamknięciu tej karty już go nie
          zobaczysz — token pozostaje aktywny do daty wygaśnięcia, ale URL musisz
          zachować w bezpiecznym miejscu (np. menedżerze haseł).
        </span>
      </AlertDescription>
    </Alert>
  );
}

function AccessRow({ access }: { access: AccountantAccess }) {
  const router = useRouter();
  const [isRevoking, startRevoking] = useTransition();

  const isExpired = new Date(access.expires_at) < new Date();
  const isRevoked = !!access.revoked_at;
  const isActive = !isRevoked && !isExpired;

  const handleRevoke = () => {
    if (!confirm(`Odebrać dostęp dla ${access.accountant_email}?`)) return;

    startRevoking(async () => {
      const result = await revokeAccountantTokenAction(access.id);
      if (result.success) {
        toast.success('Dostęp odebrany');
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <div className="flex flex-col gap-3 border p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <Avatar className="size-10 items-center justify-center">
          <AvatarFallback className="bg-transparent">
            <RiUserSettingsLine className="text-foreground size-5" />
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-medium" title={access.accountant_name}>
              {access.accountant_name}
            </p>
            {isActive && <Badge className={BADGE_OK}>Aktywny</Badge>}
            {isRevoked && <Badge className={BADGE_ERROR}>Odebrany</Badge>}
            {isExpired && !isRevoked && <Badge variant="secondary">Wygasł</Badge>}
            <Badge variant="outline">{access.access_level === 'download' ? 'Pobieranie' : 'Podgląd'}</Badge>
          </div>
          <p className="text-muted-foreground truncate font-mono text-xs" title={access.accountant_email}>
            {access.accountant_email}
          </p>
          <p className="text-muted-foreground text-xs">
            Wygasa {plDate(access.expires_at)} · {access.use_count}{' '}
            {plural(access.use_count, ['użycie', 'użycia', 'użyć'])}
            {access.last_used_at ? ` · ostatnio ${plDate(access.last_used_at)}` : ''}
          </p>
        </div>
      </div>

      {isActive && (
        <div className="flex items-center justify-end">
          <Button variant="ghost" onClick={handleRevoke} disabled={isRevoking}>
            {isRevoking ? <RiLoader4Line className="animate-spin" aria-hidden /> : 'Odbierz'}
          </Button>
        </div>
      )}
    </div>
  );
}
