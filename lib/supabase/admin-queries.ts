import { createAdminClient } from './server';
import { decryptCredentials } from '@/lib/ksef/credentials-crypto';
import type { KsefAuth } from '@/lib/ksef/auth';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import type { Invoice } from '@/types/invoice';

/**
 * Zapytania używające service_role - BYPASUJĄ RLS.
 * Używane TYLKO z jobów pg-boss (background, zaufany kontekst).
 *
 * UWAGA: NIGDY nie importuj tego pliku w client components / Server Actions
 * związanych z UI użytkownika. Tylko joby.
 */

/**
 * Parsuje BYTEA z Supabase REST API. PostgREST domyślnie zwraca BYTEA
 * jako hex string `\xAABB...` (nie base64). Jeśli w przyszłości zmienimy
 * encoding preference w Supabase, wystarczy dostosować tę funkcję.
 */
function parseBytea(raw: unknown): Buffer {
  if (typeof raw !== 'string') {
    throw new Error('ksef_credentials_encrypted has unexpected type');
  }
  if (raw.startsWith('\\x')) {
    return Buffer.from(raw.slice(2), 'hex');
  }
  // Fallback jeśli kiedyś ktoś zapisze jako base64 text.
  return Buffer.from(raw, 'base64');
}

/**
 * Ładuje credentials KSeF tenanta i zwraca jako `KsefAuth`.
 *
 * Dispatch po `type` z `TenantKsefCredentials` (discriminated union
 * w `credentials-crypto.ts`). Zwrócony `KsefAuth` ma ten sam discriminator -
 * przekazujesz go do `submitInvoiceFullFlow` bez dodatkowego mapowania.
 */
export type KsefCredentialsErrorReason =
  /** PostgREST/sieć: firma istnieje, odczyt się nie powiódł — ponowienie. */
  | 'tenant-read'
  /** NIP firmy nie jest zweryfikowany w bieżącym środowisku — klient. */
  | 'not-verified'
  /** Brak blobu poświadczeń — klient wgrywa certyfikat. */
  | 'missing'
  /** Deszyfrowanie nie powiodło się (klucz po rotacji, zły AAD) — operator. */
  | 'decrypt'
  /** NIP z szyfrogramu ≠ NIP firmy — operator. */
  | 'nip-mismatch';

/**
 * Powód, dla którego poświadczeń KSeF nie da się użyć. Runner wysyłki mapuje
 * go na kod z katalogu `ksef_error_codes` (W1 z rewizji 03.10.2026): błąd
 * odczytu bazy jest ponawiany, brak certyfikatu idzie do klienta, a kłopot
 * z kluczem do operatora — żaden nie udaje odrzucenia przez KSeF.
 */
export class KsefCredentialsError extends Error {
  constructor(
    public readonly reason: KsefCredentialsErrorReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'KsefCredentialsError';
  }
}

export async function getTenantKsefCredentials(
  tenantId: string,
): Promise<KsefAuth> {
  const environment = requireConfiguredKsefEnvironment();
  const supabase = await createAdminClient();

  const { data, error } = await supabase
    .from('tenants')
    .select('nip, ksef_credentials_encrypted, ksef_verified_at, ksef_verified_environment')
    .eq('id', tenantId)
    .single();

  if (error) {
    throw new KsefCredentialsError('tenant-read', `Tenant ${tenantId} not found: ${error.message}`);
  }
  if (!data.ksef_verified_at || data.ksef_verified_environment !== environment) {
    throw new KsefCredentialsError('not-verified', 'KSeF NIP is not verified for configured environment');
  }
  if (!data.ksef_credentials_encrypted) {
    throw new KsefCredentialsError(
      'missing',
      `Tenant ${tenantId} nie ma skonfigurowanych credentials KSeF`,
    );
  }

  let decrypted: ReturnType<typeof decryptCredentials>;
  try {
    const encryptedBlob = parseBytea(data.ksef_credentials_encrypted);
    decrypted = decryptCredentials(encryptedBlob, tenantId);
  } catch (e) {
    throw new KsefCredentialsError(
      'decrypt',
      `Nie można odszyfrować poświadczeń KSeF: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
  if (decrypted.nip !== data.nip) {
    throw new KsefCredentialsError('nip-mismatch', 'KSeF credential NIP differs from verified NIP');
  }

  // Używamy NIP-u z bazy tylko po potwierdzeniu zgodności z szyfrogramem.
  switch (decrypted.type) {
    case 'xades':
      return {
        type: 'xades',
        nip: data.nip,
        certificatePem: decrypted.certificatePem,
        privateKeyPem: decrypted.privateKeyPem,
      };
    case 'token':
      return {
        type: 'token',
        nip: data.nip,
        token: decrypted.token,
      };
    default: {
      const _exhaustive: never = decrypted;
      throw new Error(
        `Unknown credentials type: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

/**
 * Zwraca email właściciela organizacji (do alertów cert-expiry / submit-failed).
 *
 * Multi-org: właściciel(ami) jest user(zy) w `memberships` z rolą `owner`
 * dla danego organization_id. Bierzemy najstarszego (po `joined_at`) dla
 * stabilności (kolizja: kilkoro ownerów → najstarszy "primary").
 */
export async function getTenantAdminEmail(
  tenantId: string,
): Promise<string | null> {
  const ownerUserId = await getTenantOwnerUserId(tenantId);
  if (!ownerUserId) return null;

  const supabase = await createAdminClient();
  const { data: authUser } = await supabase.auth.admin.getUserById(ownerUserId);
  return authUser?.user?.email ?? null;
}

/** Najstarszy aktywny właściciel firmy — wspólne zapytanie wersji łagodnej i ścisłej. */
function selectTenantOwner(supabase: Awaited<ReturnType<typeof createAdminClient>>, tenantId: string) {
  return supabase
    .from('memberships')
    .select('user_id, joined_at')
    .eq('organization_id', tenantId)
    .eq('role', 'owner')
    .eq('status', 'active')
    .order('joined_at', { ascending: true })
    .limit(1)
    .maybeSingle();
}

/** `users.id` właściciela (owner) dla organizacji — m.in. Web Push bez auth.admin. */
export async function getTenantOwnerUserId(
  tenantId: string,
): Promise<string | null> {
  const supabase = await createAdminClient();

  const { data: owner } = await selectTenantOwner(supabase, tenantId);

  return owner?.user_id ?? null;
}

export interface TenantOwnerContact {
  /** `users.id` najstarszego aktywnego właściciela; `null` — firma nie ma właściciela. */
  ownerUserId: string | null;
  /** Adres właściciela z GoTrue; `null` — brak właściciela, konta albo adresu. */
  email: string | null;
}

/**
 * Właściciel firmy i jego e-mail — wariant ŚCISŁY `getTenantOwnerUserId`
 * i `getTenantAdminEmail` (D-A4-1b-3 PR B, przegląd #1/#4). Dla ścieżek,
 * w których powiadomienie jest jednorazowe i nic go później nie ponowi
 * („Faktura … czeka na Twoją decyzję”): błąd odczytu `memberships` albo GoTrue
 * RZUCA, więc pg-boss ponawia zadanie, zamiast udawać „brak właściciela”.
 * Prawdziwy brak danych zwraca `null` jak wersje łagodne: brak aktywnego
 * właściciela, konto bez adresu, konto, którego GoTrue nie zna (404
 * `user_not_found`). Pozostali wołający zostają przy wersjach łagodnych.
 * Oba odczyty idą przed jakąkolwiek wysyłką — błąd nie zostawia połowy.
 */
export async function readTenantOwnerContact(tenantId: string): Promise<TenantOwnerContact> {
  const supabase = await createAdminClient();
  const { data: owner, error } = await selectTenantOwner(supabase, tenantId);
  if (error) throw new Error(`Nie można odczytać właściciela firmy: ${error.message}`);
  const ownerUserId = owner?.user_id ?? null;
  if (!ownerUserId) return { ownerUserId: null, email: null };

  const { data: authUser, error: userError } = await supabase.auth.admin.getUserById(ownerUserId);
  // 404 to odpowiedź GoTrue „takiego konta nie ma” — dane, nie awaria.
  if (userError && userError.status !== 404) {
    throw new Error(`Nie można odczytać e-maila właściciela firmy: ${userError.message}`);
  }
  return { ownerUserId, email: authUser?.user?.email || null };
}

/**
 * Pobiera Invoice (model domenowy) z fa3_data JSONB.
 *
 * Schemat 00001 trzyma cały model FA(3) w jednej kolumnie JSONB
 * (`invoices.fa3_data`). Tabela `invoice_line_items` jest denormalizacją
 * dla raportowania SQL - submit-flow jej nie potrzebuje, bo `lines` są
 * już w fa3_data.
 */
export async function getInvoiceForSubmit(invoiceId: string, tenantId: string): Promise<Invoice> {
  if (!tenantId) throw new Error('Brak organizacji faktury');
  const supabase = await createAdminClient();

  const { data, error } = await supabase
    .from('invoices')
    .select('fa3_data')
    .eq('id', invoiceId)
    .eq('tenant_id', tenantId)
    .single();

  if (error) throw new Error(`Invoice ${invoiceId} not found: ${error.message}`);
  if (!data?.fa3_data) {
    throw new Error(`Invoice ${invoiceId} has no fa3_data (corrupted row?)`);
  }

  // The database blob is tenant-scoped, not a trusted shape: the submit flow
  // must still validate the document before contacting KSeF.
  return data.fa3_data as Invoice;
}

/**
 * Pola które można ustawiać w `invoices` z poziomu joba.
 * Ograniczamy celowo - żaden job nie powinien ruszać np. `tenant_id`.
 *
 * UWAGA: we wklejce było `ksef_timestamp`, ale takiej kolumny nie ma
 * w schemacie. Właściwe pola z 00001 to `submitted_to_ksef_at` (moment
 * wysłania żądania) i `ksef_accepted_at` (moment zaakceptowania przez KSeF).
 */
export interface InvoiceStatusUpdates {
  ksef_status?:
    | 'draft'
    | 'queued'
    | 'sending'
    | 'accepted'
    | 'rejected'
    | 'offline_queued'
    | 'received'
    | 'failed';
  ksef_number?: string;
  ksef_environment?: 'test' | 'demo' | 'production';
  submitted_to_ksef_at?: string;
  ksef_accepted_at?: string;
  xml_storage_path?: string;
  submission_attempts?: number;
  last_error?: string | null;
  last_error_code?: string | null;
  last_error_field?: string | null;
  last_error_suggestion?: string | null;
  last_attempt_at?: string;
}

/**
 * Pola kolumn TIMESTAMPTZ w `invoices` - puste stringi w tych polach wywalają
 * Postgres (`invalid input syntax for type timestamp with time zone: ""`),
 * dlatego przed UPDATE'em konwertujemy `""` → `null`.
 *
 * Scenariusz: KSeF czasem zwraca status "zakończony" bez `acquisitionTimestamp`
 * (race-condition na side serwera), a stary kod mapował to na pusty string.
 */
const TIMESTAMPTZ_FIELDS: ReadonlyArray<keyof InvoiceStatusUpdates> = [
  'submitted_to_ksef_at',
  'ksef_accepted_at',
  'last_attempt_at',
];

export class InvoiceStatusConflictError extends Error {
  constructor() {
    super('Stan faktury KSeF zmienił się podczas zapisu wyniku zadania');
    this.name = 'InvoiceStatusConflictError';
  }
}

/** One worker may cross the KSeF I/O boundary for an invoice. A failed claim
 * means another worker or a previous attempt may already have contacted KSeF.
 */
export async function claimInvoiceForKsefSend(
  invoiceId: string,
  tenantId: string,
  fromOfflineQueue: boolean,
): Promise<string | null> {
  if (!tenantId) throw new Error('Brak organizacji faktury');
  if (fromOfflineQueue) return null;
  const now = new Date().toISOString();
  const { data, error } = await createAdminClient()
    .from('invoices')
    .update({
      ksef_status: 'sending',
      submitted_to_ksef_at: now,
      last_attempt_at: now,
    })
    .eq('id', invoiceId)
    .eq('tenant_id', tenantId)
    .eq('direction', 'outgoing')
    .in('ksef_status', ['draft', 'queued'])
    .is('submitted_to_ksef_at', null)
    .is('last_attempt_at', null)
    .eq('submission_attempts', 0)
    .is('last_error', null)
    .is('last_error_code', null)
    .is('offline_idempotency_key', null)
    .is('ksef_number', null)
    .is('ksef_environment', null)
    .is('xml_storage_path', null)
    .select('id')
    .maybeSingle();
  if (error) throw new Error('Nie udało się atomowo przejąć wysyłki KSeF');
  // This exact timestamp is the attempt token for the result CAS. It is
  // persisted in the same conditional UPDATE that acquired the claim.
  return data?.id === invoiceId ? now : null;
}

export async function updateInvoiceStatus(
  invoiceId: string,
  updates: InvoiceStatusUpdates,
  tenantId: string,
  expectedKsefStatus?: NonNullable<InvoiceStatusUpdates['ksef_status']>,
  expectedSubmittedAt?: string,
): Promise<void> {
  if (!tenantId) throw new Error('Brak organizacji faktury');
  const supabase = await createAdminClient();
  const sanitized: Record<string, unknown> = { ...updates };
  for (const field of TIMESTAMPTZ_FIELDS) {
    if (sanitized[field] === '') {
      sanitized[field] = null;
    }
  }

  let query = supabase
    .from('invoices')
    .update(sanitized)
    .eq('id', invoiceId)
    .eq('tenant_id', tenantId);
  if (expectedKsefStatus) {
    query = query.eq('ksef_status', expectedKsefStatus);
  }
  if (expectedSubmittedAt) {
    query = query.eq('submitted_to_ksef_at', expectedSubmittedAt);
  }
  const { data, error } = await query
    .select('id')
    .maybeSingle();
  if (!error && !data && (expectedKsefStatus || expectedSubmittedAt)) {
    throw new InvoiceStatusConflictError();
  }
  if (error || !data || data.id !== invoiceId) {
    throw new Error('Nie udało się zaktualizować faktury w organizacji zadania');
  }
}
