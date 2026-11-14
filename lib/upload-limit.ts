/**
 * Limity plików wgrywanych z przeglądarki (plan skalowania, sesje 4 i 31;
 * HOR-V1, LIM-08, CPU-06). Moduł bez zależności serwerowych — czytają go
 * okna wgrywania i trasy.
 *
 * Pliki NIE idą przez Server Actions: Next przyjmuje w ciele akcji najwyżej
 * 1 MiB, a podniesienie `serverActions.bodySizeLimit` działałoby na wszystkie
 * akcje naraz (decyzja Bartosza 03.11, wariant b). Idą trasami
 * `/api/uploads/expense` (zdjęcie albo PDF kosztu), `/api/uploads/import`
 * (CSV importu), `/api/uploads/logo` (logo firmy na fakturze) i
 * `/share-target` (udostępnienie z telefonu), które mają
 * własny limit `Content-Length` i odmawiają przed odczytem ciała
 * (`lib/uploads/server.ts`). Trasy są poza proxy, bo proxy Next czyta całe
 * ciało i trzyma w pamięci jego kopię do 10 MiB, zanim trasa ruszy
 * (`tests/unit/wgrywanie-proxy-matcher.test.ts`).
 *
 * Przeglądarka sprawdza te same limity przed wysłaniem, żeby klient dostał
 * polski komunikat zamiast zerwanego połączenia.
 */

/** Największy plik: PDF kosztu albo CSV importu. 10 MB dziesiętnie, czyli tyle, ile „10 MB” znaczy na telefonie. */
export const UPLOAD_FILE_LIMIT_BYTES = 10_000_000;

/** Ten sam limit w komunikatach dla klienta. */
export const UPLOAD_FILE_LIMIT_LABEL = '10 MB';

/**
 * Największe zdjęcie kosztu (próg odczytu, OCR). API modelu przyjmuje obraz
 * do 10 MB po zakodowaniu base64, a base64 to 4/3 pliku, więc granica to
 * ok. 7,5 MB pliku. Zdjęcie ponad nią przechodziło wgranie i padało dopiero
 * w workerze, z angielskim błędem API. 7 MB zostawia zapas na to, że nie
 * wiadomo, czy „10 MB” w API to MB czy MiB i czy granica jest włączna.
 */
export const UPLOAD_IMAGE_LIMIT_BYTES = 7_000_000;

/** Ten sam próg w komunikatach dla klienta. */
export const UPLOAD_IMAGE_LIMIT_LABEL = '7 MB';

/**
 * Najdłuższe ciało żądania wgrania: plik plus granice multipart i pola obok
 * (nazwa pliku, źródło importu, firma). Realnie to ok. 0,5–1 KB, zapas
 * 64 KiB. Musi zostać poniżej 10 MiB (`proxyClientMaxBodySize` Next): gdyby
 * trasa wróciła pod proxy, dłuższe ciało dotarłoby do niej ucięte.
 */
export const UPLOAD_BODY_LIMIT_BYTES = UPLOAD_FILE_LIMIT_BYTES + 64 * 1024;

/**
 * Największy plik logo firmy (plan kompletnej aplikacji, krok 2.2): PNG albo
 * JPEG na wydruk faktury, proformy i oferty. Logo ma na wydruku 40 pt
 * wysokości, więc 2 MB to zapas na pliki prosto z programu graficznego.
 * Trasa `/api/uploads/logo` odmawia większego ciała przed jego odczytem.
 */
export const LOGO_FILE_LIMIT_BYTES = 2_000_000;

/** Ten sam limit w komunikatach dla klienta. */
export const LOGO_FILE_LIMIT_LABEL = '2 MB';

/** Najdłuższe ciało żądania wgrania logo: plik i pole firmy, zapas jak wyżej. */
export const LOGO_BODY_LIMIT_BYTES = LOGO_FILE_LIMIT_BYTES + 64 * 1024;

/**
 * Rozmiar do komunikatu, w jednostkach dziesiętnych i zaokrąglony w górę:
 * plik ponad limit nigdy nie wygląda na mieszczący się („10,1 MB”, a nie
 * „10,0 MB, a można najwyżej 10 MB”).
 */
export function formatUploadSize(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(1, Math.ceil(bytes / 1000))} KB`;
  return `${(Math.ceil(bytes / 100_000) / 10).toFixed(1).replace('.', ',')} MB`;
}

/** Zerwane połączenie, restart serwera, odpowiedź bramki bez JSON. */
export const UPLOAD_FAILED_MESSAGE = 'Nie udało się wysłać pliku. Sprawdź połączenie i spróbuj ponownie.';
