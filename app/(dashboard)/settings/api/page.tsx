import { notFound } from 'next/navigation';

import { ApiKeysList, type ApiKeyPublicRow } from '@/components/settings/api-keys-list';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { isPublicApiEnabled } from '@/lib/api/v1/availability';
import { getPageContextWithRole } from '@/lib/supabase/page-context';

export const dynamic = 'force-dynamic';

function toPublicKeys(rows: Record<string, unknown>[] | null): ApiKeyPublicRow[] {
  return (rows ?? []).map((r) => ({
    id: String(r.id),
    name: String(r.name ?? ''),
    key_prefix: String(r.key_prefix ?? ''),
    scopes: Array.isArray(r.scopes) ? r.scopes.map(String) : [],
    created_at: String(r.created_at ?? ''),
    last_used_at: r.last_used_at != null ? String(r.last_used_at) : null,
    revoked_at: r.revoked_at != null ? String(r.revoked_at) : null,
  }));
}

/**
 * Zakładka „API” (krok 7.1 planu kompletnej aplikacji): klucze API firmy.
 * Tylko właściciel i administrator; przed udostępnieniem API (flaga
 * `publicApiEnabled`) strony nie ma. Lista klientem z sesji: RLS z 00181
 * pokazuje klucze tylko właścicielowi i administratorowi, bez skrótu.
 */
export default async function ApiKeysPage() {
  if (!(await isPublicApiEnabled())) notFound();
  const { supabase, tenantId } = await getPageContextWithRole(['owner', 'admin'], '/settings');

  const { data, error } = await supabase
    .from('api_keys')
    .select('id, name, key_prefix, scopes, created_at, last_used_at, revoked_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(100);

  return (
    <FieldGroup>
      <div>
        <FieldLabel>Klucze API</FieldLabel>
        <FieldDescription>
          Klucz pozwala Twojemu programowi czytać faktury albo koszty tej firmy przez API FaktWay. Opis API:{' '}
          <a href="/api/docs" className="underline">faktway.pl/api/docs</a>.
        </FieldDescription>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>Nie udało się wczytać kluczy API. Odśwież stronę za chwilę.</AlertDescription>
        </Alert>
      ) : (
        <ApiKeysList keys={toPublicKeys(data as Record<string, unknown>[] | null)} />
      )}
    </FieldGroup>
  );
}
