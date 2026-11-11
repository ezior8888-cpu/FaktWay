/**
 * Object metadata is writable through tenant-scoped database policies.
 * Owning its row does not grant access to an arbitrary storage key.
 */
export function isTenantStoragePath(key: string, tenantId: string): boolean {
  if (!tenantId || /[/\\\x00-\x1f]/.test(tenantId)) return false;
  if (/[\\\x00-\x1f]/.test(key)) return false;
  const segments = key.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return false;
  }
  return (
    key.startsWith(`${tenantId}/`) ||
    ['tenants', 'exports', 'imports', 'upo', 'reminders'].some((prefix) =>
      key.startsWith(`${prefix}/${tenantId}/`),
    )
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Plik paczki archiwum dokumentów (krok 6.4; 00178, 00190): jeden plik
 * bezpośrednio w katalogu zlecenia `exports/<firma>/archiwum/<zlecenie>/`.
 * Bez `..`, bez podkatalogów, bez znaków sterujących i ukośnika wstecznego.
 * Tylko taki klucz wolno usunąć zadaniu sprzątającemu: katalog innego
 * zlecenia, zwykły eksport albo dokument firmy (XML, PDF, UPO, zdjęcie)
 * nie spełnia warunku.
 */
export function isDocumentArchiveFileKey(key: string, tenantId: string, archiveId: string): boolean {
  if (!UUID_RE.test(tenantId) || !UUID_RE.test(archiveId)) return false;
  const prefix = `exports/${tenantId}/archiwum/${archiveId}/`;
  if (!key.startsWith(prefix) || key.includes('..')) return false;
  const name = key.slice(prefix.length);
  if (!name || /[/\\\x00-\x1f\x7f]/.test(name)) return false;
  return isTenantStoragePath(key, tenantId);
}

export function assertTenantStoragePath(key: string, tenantId: string): void {
  if (!isTenantStoragePath(key, tenantId)) {
    // Deliberately do not disclose either the supplied key or tenant id.
    throw new Error('Storage path does not belong to this organization');
  }
}
