import { getGlobalFlag } from '@/lib/feature-flags/global-flags';

/**
 * Publiczne API jest udostępnione dopiero po regulaminie API (pytanie 15 do
 * prawnika) i zewnętrznym teście zabezpieczeń (krok 7.1 planu kompletnej
 * aplikacji). Do tego czasu flaga `publicApiEnabled` (00181) ma `false`:
 * `/api/v1` odpowiada 503 `api_disabled`, a zakładka „API” jest ukryta.
 *
 * To WŁĄCZNIK: błąd odczytu flagi daje `false` (`getGlobalFlag`), czyli API
 * zostaje zamknięte. Ścieżka operatora: UPDATE `global_feature_flags` kluczem
 * serwisowym, zmiana dociera do minuty (cache flag).
 */
export function isPublicApiEnabled(): Promise<boolean> {
  return getGlobalFlag('publicApiEnabled');
}
