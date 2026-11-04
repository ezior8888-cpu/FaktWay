/**
 * Przeszyfrowanie danych dostępowych KSeF do formatu v2 bieżącym kluczem (AUD-52).
 *
 * Kiedy: po wdrożeniu kodu v2, a przy rotacji sekretu — po ustawieniu
 * nowego `KSEF_CREDENTIALS_ENCRYPTION_KEY` i starego w
 * `KSEF_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS`. Czyta każdy zapis (v1 albo v2,
 * bieżący albo poprzedni klucz), zapisuje v2 bieżącym kluczem z AAD firmy.
 * `_PREVIOUS` można usunąć dopiero, gdy przebieg z `--apply` zakończy się
 * kodem 0 i komunikatem „wszystkie zapisy na bieżącym kluczu”. Kod 1 = powtórz.
 *
 * Domyślnie TYLKO podgląd. Zapis: `pnpm tsx scripts/reencrypt-ksef-credentials.ts --apply`.
 * `--force` przeszyfrowuje także zapisy już na bieżącym kluczu (nowa sól i IV).
 * Wymaga klucza service_role (jak pozostałe skrypty w `scripts/`).
 * Logika: lib/ksef/reencrypt-credentials.ts (sesja 27 planu skalowania).
 */

import { config } from 'dotenv';

import { reencryptComplete, reencryptKsefCredentials } from '../lib/ksef/reencrypt-credentials';

import { createScriptAdminClient } from './_supabase';

config({ path: '.env.local' });

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const report = await reencryptKsefCredentials(createScriptAdminClient(), {
    apply,
    force: process.argv.includes('--force'),
    // Bez treści danych — tylko identyfikator firmy i rodzaj błędu.
    log: (line) => console.error(line),
  });
  console.log(
    `Przeczytano: ${report.read} (w bazie: ${report.total}). ` +
      `${apply ? 'Przeszyfrowano' : 'Do przeszyfrowania (podgląd)'}: ${report.rewritten}, ` +
      `już na bieżącym kluczu: ${report.alreadyCurrent}, zmienione w trakcie: ${report.changedMeanwhile}, ` +
      `błędy: ${report.failed}`,
  );
  if (!reencryptComplete(report)) {
    console.error('Przebieg niekompletny — powtórz go. NIE usuwaj KSEF_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS.');
    process.exit(1);
  }
  if (apply) console.log('Wszystkie zapisy na bieżącym kluczu — KSEF_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS można usunąć.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
