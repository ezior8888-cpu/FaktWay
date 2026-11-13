/**
 * Kontrakt API aplikacji (`/api/mobile/v1`) prosto ze strony: nagłówki, kody
 * błędów i kształty odpowiedzi (plan aplikacji 4.1, decyzja M6). Plik strony
 * nie ma importów (pilnuje `tests/unit/mobile-api-kontrakt.test.ts`), więc
 * Metro bierze go bez kodu serwera; katalog jest w `watchFolders`
 * (`metro.config.js`). Zmiana kontraktu w PR strony od razu zmienia typy tutaj.
 */
export * from '../../../../lib/api/mobile/kontrakt';
