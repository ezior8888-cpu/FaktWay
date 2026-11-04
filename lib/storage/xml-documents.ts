/**
 * Wiersz `xml_documents` dla XML-a przyjętego przez KSeF (AUD-12).
 *
 * Tabela ma czterech czytelników — PDF (kod QR KOD I z SHA-256 pliku),
 * „Pobierz XML” (weryfikacja skrótu), portal księgowej i archiwizacja do
 * Glacier — a do 02.10.2026 nikt jej nie zapisywał (00027 zakładał, że robi
 * to warstwa magazynu). Zapis idzie przez klienta admina: `authenticated`
 * nie ma prawa zapisu do tej tabeli (00027).
 *
 * C-12: wiersz to dowód pliku z 10-letnią retencją, więc raz zapisany się nie
 * zmienia. Jeden wiersz na fakturę pilnuje UNIQUE (tenant_id, invoice_id) z 00164:
 * ponowienie tego samego pliku to no-op, inny plik to `XmlDocumentConflictError`.
 */

import { createHash } from 'node:crypto';

import { SUPPORT_EMAIL } from '@/lib/site';
import { createAdminClient } from '@/lib/supabase/admin';

import { downloadFromR2 } from './r2';
import { assertTenantStoragePath } from './tenant-path';

const UNIQUE_VIOLATION = '23505';

export interface XmlDocumentRecord {
  tenantId: string;
  invoiceId: string;
  storagePath: string;
  /** SHA-256 (hex) dokładnych bajtów pliku, który poszedł do KSeF albo z niego przyszedł. */
  sha256Hash: string;
  sizeBytes?: number;
  /**
   * Odczytaj plik z magazynu i porównaj jego bajty ze skrótem, zanim powstanie
   * wiersz. Dla wysyłki, która nie widziała tych bajtów w tym przebiegu
   * (uzgodnienie, duplikat). Import i skrzynka tego nie potrzebują:
   * `archiveImportedKsefXml` przed chwilą porównał bajty, a dodatkowy GET
   * na każdą fakturę to koszt, którego pilnuje plan skalowania.
   */
  verifyStoredBytes?: boolean;
}

/**
 * Dowód się nie zgadza: istniejący wiersz wskazuje inny plik albo plik
 * w magazynie nie jest tym, który wysłaliśmy. Komunikat trafia do klienta
 * (raport importu), więc bez ścieżek i identyfikatorów. Ścieżka operatora:
 * `docs/runbooks/ksef-error-codes.md`, „Faktura przyjęta bez wiersza xml_documents”.
 */
export class XmlDocumentConflictError extends Error {
  constructor() {
    super(`Oryginał XML tej faktury nie zgadza się z zapisanym plikiem. Niczego nie nadpisujemy — napisz do pomocy FaktWay (${SUPPORT_EMAIL}).`);
    this.name = 'XmlDocumentConflictError';
  }
}

interface Evidence {
  storagePath: string;
  sha256Hash: string;
  sizeBytes?: number;
}

async function readRow(record: XmlDocumentRecord) {
  const { data, error } = await createAdminClient()
    .from('xml_documents')
    .select('storage_path, sha256_hash, file_size_bytes')
    .eq('invoice_id', record.invoiceId)
    .eq('tenant_id', record.tenantId)
    .maybeSingle();
  if (error) throw new Error(`xml_documents: ${error.message}`);
  return data;
}

/** Rozmiar bywa NULL (przyjęcie z duplikatu go nie zna): brak to nie konflikt. */
function assertSameDocument(row: NonNullable<Awaited<ReturnType<typeof readRow>>>, evidence: Evidence): void {
  const sameSize = row.file_size_bytes == null || evidence.sizeBytes === undefined
    || row.file_size_bytes === evidence.sizeBytes;
  if (row.storage_path !== evidence.storagePath || row.sha256_hash !== evidence.sha256Hash || !sameSize) {
    throw new XmlDocumentConflictError();
  }
}

async function storedSize(record: XmlDocumentRecord, sha256Hash: string): Promise<number> {
  const bytes = await downloadFromR2(record.storagePath, record.tenantId);
  const stored = createHash('sha256').update(bytes).digest('hex');
  if (stored !== sha256Hash || (record.sizeBytes !== undefined && record.sizeBytes !== bytes.length)) {
    throw new XmlDocumentConflictError();
  }
  return bytes.length;
}

export async function recordXmlDocument(record: XmlDocumentRecord): Promise<void> {
  assertTenantStoragePath(record.storagePath, record.tenantId);
  const sha256Hash = record.sha256Hash.toLowerCase();
  const expected: Evidence = { storagePath: record.storagePath, sha256Hash, sizeBytes: record.sizeBytes };

  const existing = await readRow(record);
  if (existing) {
    assertSameDocument(existing, expected);
    return;
  }

  const sizeBytes = record.verifyStoredBytes ? await storedSize(record, sha256Hash) : record.sizeBytes;
  const { error } = await createAdminClient().from('xml_documents').insert({
    invoice_id: record.invoiceId,
    tenant_id: record.tenantId,
    storage_provider: 'r2',
    storage_path: record.storagePath,
    sha256_hash: sha256Hash,
    file_size_bytes: sizeBytes ?? null,
  });
  if (!error) return;
  if (error.code !== UNIQUE_VIOLATION) throw new Error(`xml_documents: ${error.message}`);

  // Sam konflikt klucza nie jest sukcesem: wiersz zwycięzcy ma wskazywać ten sam plik.
  const winner = await readRow(record);
  if (!winner) throw new Error('xml_documents: konflikt zapisu bez wiersza zwycięzcy');
  assertSameDocument(winner, { ...expected, sizeBytes });
}
