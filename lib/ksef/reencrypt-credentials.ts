/**
 * Przeszyfrowanie danych dostępowych KSeF bieżącym kluczem (AUD-52) — logika
 * skryptu `scripts/reencrypt-ksef-credentials.ts`, wyniesiona, żeby dało się
 * ją sprawdzić na atrapie bazy (tests/unit/przeszyfrowanie-ksef-strony.test.ts).
 *
 * Sesja 27 planu skalowania:
 *   - firmy czytane stronami po kluczu — dawniej jedno zapytanie oddawało
 *     najwyżej 1000 firm (PGRST_DB_MAX_ROWS): skrypt przeszyfrowywał 1000,
 *     zgłaszał sukces, a nagłówek kazał potem usunąć stary klucz,
 *   - pomijane są tylko zapisy już zaszyfrowane BIEŻĄCYM kluczem (odcisk),
 *     a nie każde v2 — przy rotacji v2 starym kluczem liczyło się jako
 *     „już v2” i zostawało na kluczu, który operator miał zaraz usunąć,
 *   - zapis warunkowy na `updated_at` z `.select('id')`: dane wgrane przez
 *     klienta między odczytem a zapisem nie zostaną nadpisane starymi,
 *     a 0 zmienionych wierszy to „zmieniona w trakcie”, nie sukces,
 *   - raport z liczbą przeczytanych zapisów obok liczby w bazie.
 *
 * Bez importów `@/…`: skrypt importuje `lib/` ścieżką względną.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { forEachPageById } from '../pagination/keyset';
import { bufferToByteaLiteral } from '../supabase/bytea';

import { decryptCredentials, encryptCredentials, isEncryptedWithCurrentKey } from './credentials-crypto';

/** Mniejsza strona niż domyślne 500: blob XAdES to kilka–kilkanaście KB. */
const REENCRYPT_PAGE_SIZE = 200;

export interface ReencryptOptions {
  /** Bez `apply` — tylko podgląd, nic nie zapisuje. */
  apply: boolean;
  /** Przeszyfruj także zapisy już na bieżącym kluczu (nowa sól i IV). */
  force: boolean;
  /** Linie diagnostyczne — tylko identyfikator firmy i rodzaj błędu, bez treści danych. */
  log?: (line: string) => void;
}

export interface ReencryptReport {
  /** Liczba firm z zapisanymi danymi według bazy (`count`), przed przebiegiem. */
  total: number;
  /** Zapisy przeczytane stronami. */
  read: number;
  /** Przeszyfrowane (w podglądzie: do przeszyfrowania). */
  rewritten: number;
  /** Już zaszyfrowane bieżącym kluczem — pominięte. */
  alreadyCurrent: number;
  /** Firma zmieniona albo usunięta między odczytem a zapisem — do powtórki. */
  changedMeanwhile: number;
  /** Błąd odczytu, odszyfrowania albo zapisu. */
  failed: number;
}

interface CredentialsRow {
  id: string;
  ksef_credentials_encrypted: unknown;
  updated_at: string | null;
}

function parseBytea(raw: unknown): Buffer {
  if (typeof raw !== 'string') throw new Error('nieoczekiwany typ BYTEA');
  return raw.startsWith('\\x') ? Buffer.from(raw.slice(2), 'hex') : Buffer.from(raw, 'base64');
}

export async function reencryptKsefCredentials(
  client: SupabaseClient,
  options: ReencryptOptions,
): Promise<ReencryptReport> {
  const log = options.log ?? (() => {});
  const report: ReencryptReport = { total: 0, read: 0, rewritten: 0, alreadyCurrent: 0, changedMeanwhile: 0, failed: 0 };

  const { count, error: countError } = await client
    .from('tenants')
    .select('id', { count: 'exact', head: true })
    .not('ksef_credentials_encrypted', 'is', null);
  if (countError || typeof count !== 'number') {
    throw new Error(`Przeszyfrowanie: liczba firm: ${countError?.message ?? 'brak liczby'}`);
  }
  report.total = count;

  await forEachPageById<CredentialsRow>(
    'Przeszyfrowanie: odczyt firm',
    (afterId, limit) => {
      let query = client
        .from('tenants')
        .select('id, ksef_credentials_encrypted, updated_at')
        .not('ksef_credentials_encrypted', 'is', null);
      if (afterId) query = query.gt('id', afterId);
      return query.order('id', { ascending: true }).limit(limit);
    },
    async (rows) => {
      for (const row of rows) {
        report.read += 1;
        try {
          const blob = parseBytea(row.ksef_credentials_encrypted);
          const creds = decryptCredentials(blob, row.id);
          if (isEncryptedWithCurrentKey(blob) && !options.force) {
            report.alreadyCurrent += 1;
            continue;
          }
          if (options.apply) {
            let update = client
              .from('tenants')
              .update({ ksef_credentials_encrypted: bufferToByteaLiteral(encryptCredentials(creds, row.id)) })
              .eq('id', row.id);
            update = row.updated_at === null ? update.is('updated_at', null) : update.eq('updated_at', row.updated_at);
            const { data, error } = await update.select('id');
            if (error) throw new Error(error.message);
            if (!data || data.length === 0) {
              report.changedMeanwhile += 1;
              log(`firma ${row.id}: zmieniona albo usunięta w trakcie przebiegu — bez zapisu, powtórz przebieg`);
              continue;
            }
          }
          report.rewritten += 1;
        } catch (e) {
          report.failed += 1;
          log(`firma ${row.id}: ${e instanceof Error ? e.message : 'błąd'}`);
        }
      }
    },
    { pageSize: REENCRYPT_PAGE_SIZE },
  );

  return report;
}

/**
 * Przebieg kompletny: przeczytany co najmniej każdy zapis policzony przez bazę
 * (nowe firmy w trakcie i tak dostają bieżący klucz), bez błędów i bez firm
 * zmienionych w trakcie. Dopiero po kompletnym przebiegu z `apply` wolno
 * usunąć `KSEF_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS`.
 */
export function reencryptComplete(report: ReencryptReport): boolean {
  return report.failed === 0 && report.changedMeanwhile === 0 && report.read >= report.total;
}
