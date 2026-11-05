import { unstable_isUnrecognizedActionError } from 'next/navigation';

/**
 * Limit pliku wysyłanego z przeglądarki przez Server Action (plan
 * skalowania, sesja 4; HOR-V1, LIM-08, CPU-06).
 *
 * Next przyjmuje w ciele Server Action najwyżej 1 MiB (domyślny
 * `serverActions.bodySizeLimit`, `next.config.ts` go nie zmienia) i odrzuca
 * większe żądanie, zanim akcja ruszy. Kontrole „max 10 MB” w akcjach
 * (`uploadExpensePhotoAction`, `startFileImportAction`) są więc dla panelu
 * nieosiągalne — działają tylko dla `/share-target`, który woła akcję jak
 * zwykłą funkcję. Przeglądarka sprawdza ten limit sama, żeby klient dostał
 * polski komunikat zamiast odrzuconego żądania.
 *
 * Podniesienie limitu działa na wszystkie Server Actions naraz, a akcja
 * trzyma plik 2–3 razy w pamięci jedynego procesu web — decyzja Bartosza.
 * Zmiana limitu w `next.config.ts` = zmiana stałych niżej.
 */

/** Limit ciała Server Action w Next (`bodySizeLimit`, domyślnie 1 MiB). */
export const ACTION_BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * Największy plik, jaki przeglądarka wyśle przez Server Action: 1 MB
 * dziesiętnie, czyli tyle, ile „1 MB” znaczy na telefonie i w macOS.
 * Do limitu ciała zostaje ok. 47 KB na resztę żądania (granice multipart,
 * nagłówek pola z nazwą pliku, pole z argumentami akcji) — realnie zajmuje
 * ok. 0,5–1 KB, sprawdza to `tests/unit/limit-wgrywania-akcji.test.ts`
 * na prawdziwym koderze Reacta.
 */
export const ACTION_FILE_LIMIT_BYTES = 1_000_000;

/** Ten sam limit w komunikatach dla klienta. */
export const ACTION_FILE_LIMIT_LABEL = '1 MB';

/**
 * Rozmiar do komunikatu, w jednostkach dziesiętnych i zaokrąglony w górę:
 * plik ponad limit nigdy nie wygląda na mieszczący się („1,1 MB”, a nie
 * „1,0 MB, a można najwyżej 1 MB”).
 */
export function formatUploadSize(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(1, Math.ceil(bytes / 1000))} KB`;
  return `${(Math.ceil(bytes / 100_000) / 10).toFixed(1).replace('.', ',')} MB`;
}

/** Odrzucona obietnica akcji: 413 od Next, zerwane połączenie, restart serwera. */
export const UPLOAD_FAILED_MESSAGE = 'Nie udało się wysłać pliku. Sprawdź połączenie i spróbuj ponownie.';

/** Strona sprzed wdrożenia woła akcję, której nowy build już nie zna. */
export const UPLOAD_APP_UPDATED_MESSAGE = 'Aplikacja została zaktualizowana. Odśwież stronę i wgraj plik ponownie.';

/** Komunikat dla odrzuconej obietnicy akcji wgrania. */
export function uploadRejectedMessage(error: unknown): string {
  return unstable_isUnrecognizedActionError(error) ? UPLOAD_APP_UPDATED_MESSAGE : UPLOAD_FAILED_MESSAGE;
}
