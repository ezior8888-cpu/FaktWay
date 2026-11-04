/**
 * Czy zadanie już czeka w kolejce. `singletonKey` na kolejce `standard` tego nie
 * pilnuje (`lib/jobs/enqueue.ts`), więc nadawca, który nie chce dokładać dubli,
 * pyta o to wprost. Po polu danych, bo ponowienie z `run-job.ts` nie niesie klucza.
 */

import { startBoss } from './boss';
import { getJobsSchema } from './config';

const SAFE_FIELD = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/**
 * Wartości pola `data->>field`, dla których istnieje zadanie jeszcze niezakończone
 * (czeka, czeka na ponowienie albo trwa). Stan zawęża odczyt do kilku wierszy
 * (`pgboss.job` trzyma ukończone zadania 7 dni, ale tych tu nie czytamy).
 */
export async function findWaitingJobsByDataField(
  queue: string,
  field: string,
  values: readonly string[],
): Promise<Set<string>> {
  if (values.length === 0) return new Set();
  if (!SAFE_FIELD.test(field)) throw new Error(`Niedozwolone pole zadania: ${field}`);
  const boss = await startBoss();
  const { rows } = await boss.getDb().executeSql(
    `SELECT data->>'${field}' AS value
       FROM ${getJobsSchema()}.job
      WHERE name = $1
        AND state IN ('created', 'retry', 'active')
        AND data->>'${field}' = ANY($2::text[])`,
    [queue, [...values]],
  );
  return new Set((rows as Array<{ value: string }>).map((row) => row.value));
}
