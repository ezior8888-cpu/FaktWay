'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RiAddLine, RiCloseLine, RiFileCopyLine, RiKey2Line, RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { MfaStepUpNotice } from '@/components/auth/mfa-step-up-notice';
import { createApiKeyAction, revokeApiKeyAction } from '@/components/settings/api-keys-actions';
import { formatSettingsDate } from '@/components/settings/finora/format-date';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  API_KEY_SCOPE_LABELS,
  API_KEY_SCOPES,
  apiKeyCreateSchema,
  MAX_ACTIVE_API_KEYS,
  type ApiKeyScope,
} from '@/lib/api/v1/scopes';

/**
 * Klucze API firmy (krok 7.1). Wygląd i układ jak lista linków dla księgowej
 * (`accountant-list.tsx`): nagłówek z przyciskiem, formularz w ramce, karta
 * z kluczem pokazanym raz, wiersze z odznaką stanu i akcją po prawej (D1:
 * istniejące komponenty, bez nowego wyglądu).
 */

export interface ApiKeyPublicRow {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const BADGE_OK = 'bg-green-600/10 text-green-800 dark:bg-green-400/10 dark:text-green-400';
const BADGE_ERROR = 'bg-red-600/10 text-red-600 dark:bg-red-400/10 dark:text-red-400';

function scopeLabel(scope: string): string {
  return API_KEY_SCOPE_LABELS[scope as ApiKeyScope] ?? scope;
}

export function ApiKeysList({ keys }: { keys: ApiKeyPublicRow[] }) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const activeCount = keys.filter((k) => !k.revoked_at).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-between gap-2 max-sm:flex-col sm:items-center">
        <div>
          <p className="text-sm font-medium">Klucze tej firmy</p>
          <p className="text-muted-foreground text-xs">
            Aktywne klucze: <span className="text-foreground font-medium">{activeCount}</span> z {MAX_ACTIVE_API_KEYS}
          </p>
        </div>
        <Button
          onClick={() => {
            setShowForm(true);
            setCreatedKey(null);
          }}
          disabled={activeCount >= MAX_ACTIVE_API_KEYS}
        >
          <RiAddLine aria-hidden />
          Nowy klucz
        </Button>
      </div>

      {createdKey && <CreatedKeyCard apiKey={createdKey} onClose={() => setCreatedKey(null)} />}

      {showForm && !createdKey && (
        <CreateKeyForm
          onSuccess={(key) => {
            setCreatedKey(key);
            setShowForm(false);
            router.refresh();
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {keys.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <RiKey2Line />
            </EmptyMedia>
            <EmptyTitle>Brak kluczy API</EmptyTitle>
            <EmptyDescription>Utwórz klucz, żeby Twój program mógł czytać faktury albo koszty tej firmy.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {keys.map((key) => (
            <KeyRow key={key.id} apiKey={key} />
          ))}
        </div>
      )}
    </div>
  );
}

function CreateKeyForm({ onSuccess, onCancel }: { onSuccess: (key: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiKeyScope[]>(['invoices:read']);
  const [stepUp, setStepUp] = useState<string | null>(null);
  const [isCreating, startCreating] = useTransition();

  const toggleScope = (scope: ApiKeyScope, checked: boolean) => {
    setScopes((current) => (checked ? [...new Set([...current, scope])] : current.filter((s) => s !== scope)));
  };

  const handleSubmit = () => {
    const parsed = apiKeyCreateSchema.safeParse({ name, scopes });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Niepoprawne dane klucza.');
      return;
    }
    setStepUp(null);
    startCreating(async () => {
      const result = await createApiKeyAction(parsed.data);
      if (result.success) {
        toast.success('Klucz API utworzony');
        onSuccess(result.key);
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
          <p className="text-sm font-medium">Nowy klucz API</p>
          <p className="text-muted-foreground text-xs">Klucz pokażemy tylko raz. Zapisz go w programie albo w menedżerze haseł.</p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onCancel} aria-label="Zamknij">
          <RiCloseLine aria-hidden />
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="api-key-name">Nazwa klucza</FieldLabel>
          <Input
            id="api-key-name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            placeholder="np. Program magazynowy"
          />
        </Field>
        <Field>
          <FieldLabel>Co program może czytać</FieldLabel>
          <div className="flex flex-col gap-2">
            {API_KEY_SCOPES.map((scope) => (
              <label key={scope} className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox
                  checked={scopes.includes(scope)}
                  onCheckedChange={(checked) => toggleScope(scope, checked === true)}
                />
                {API_KEY_SCOPE_LABELS[scope]}
              </label>
            ))}
          </div>
        </Field>
      </div>

      {stepUp ? (
        <MfaStepUpNotice returnTo="/settings/api">
          {stepUp} Po potwierdzeniu wrócisz tutaj.
        </MfaStepUpNotice>
      ) : null}

      <div className="flex gap-3 sm:justify-end">
        <Button variant="outline" onClick={onCancel} disabled={isCreating}>
          Anuluj
        </Button>
        <Button onClick={handleSubmit} disabled={isCreating}>
          {isCreating && <RiLoader4Line className="animate-spin" aria-hidden />}
          Utwórz klucz
        </Button>
      </div>
    </div>
  );
}

function CreatedKeyCard({ apiKey, onClose }: { apiKey: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(apiKey);
    setCopied(true);
    toast.success('Klucz skopiowany do schowka');
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Alert role="status" className="border-none bg-green-600/10 text-green-800 dark:bg-green-400/10 dark:text-green-400">
      <AlertTitle>Klucz API utworzony</AlertTitle>
      <AlertDescription className="flex flex-col gap-3 text-green-800 dark:text-green-400/80">
        <div className="flex items-start justify-between gap-3">
          <span>Skopiuj klucz i wklej go w swoim programie.</span>
          <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Zamknij">
            <RiCloseLine aria-hidden />
          </Button>
        </div>
        <div className="flex gap-2">
          <Input
            readOnly
            value={apiKey}
            aria-label="Klucz API"
            className="text-foreground font-mono text-xs"
            onClick={(e) => (e.target as HTMLInputElement).select()}
          />
          <Button onClick={handleCopy} className="shrink-0">
            <RiFileCopyLine aria-hidden />
            {copied ? 'Skopiowano!' : 'Kopiuj'}
          </Button>
        </div>
        <span>
          Pełny klucz widać tylko teraz. FaktWay przechowuje wyłącznie jego skrót, więc po zamknięciu tej karty
          klucza nie da się odczytać. Zgubiony klucz odwołaj i utwórz nowy. Klucz trzymaj na serwerze, nigdy
          w przeglądarce ani w aplikacji w telefonie.
        </span>
      </AlertDescription>
    </Alert>
  );
}

function KeyRow({ apiKey }: { apiKey: ApiKeyPublicRow }) {
  const router = useRouter();
  const [isRevoking, startRevoking] = useTransition();
  const isRevoked = Boolean(apiKey.revoked_at);

  const handleRevoke = () => {
    if (!confirm(`Odwołać klucz „${apiKey.name}”? Programy, które go używają, od razu stracą dostęp.`)) return;
    startRevoking(async () => {
      const result = await revokeApiKeyAction(apiKey.id);
      if (result.success) {
        toast.success('Klucz API odwołany');
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
            <RiKey2Line className="text-foreground size-5" />
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-medium" title={apiKey.name}>
              {apiKey.name}
            </p>
            {isRevoked ? <Badge className={BADGE_ERROR}>Odwołany</Badge> : <Badge className={BADGE_OK}>Aktywny</Badge>}
            {apiKey.scopes.map((scope) => (
              <Badge key={scope} variant="outline">
                {scopeLabel(scope)}
              </Badge>
            ))}
          </div>
          <p className="text-muted-foreground truncate font-mono text-xs">{apiKey.key_prefix}…</p>
          <p className="text-muted-foreground text-xs">
            Utworzony {formatSettingsDate(apiKey.created_at)}
            {' · '}
            {apiKey.last_used_at ? `ostatnio użyty ${formatSettingsDate(apiKey.last_used_at)}` : 'jeszcze nieużyty'}
            {isRevoked ? ` · odwołany ${formatSettingsDate(apiKey.revoked_at)}` : ''}
          </p>
        </div>
      </div>

      {!isRevoked && (
        <div className="flex items-center justify-end">
          <Button variant="ghost" onClick={handleRevoke} disabled={isRevoking}>
            {isRevoking ? <RiLoader4Line className="animate-spin" aria-hidden /> : 'Odwołaj'}
          </Button>
        </div>
      )}
    </div>
  );
}
