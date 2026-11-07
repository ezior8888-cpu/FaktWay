# Zmiany na telefon (Mac zamrożony)

Decyzja Bartosza z 03.11.2026: wygląd aplikacji na Macu i laptopie jest
zaakceptowany i zamrożony. Zmiana „na telefon” nie może ruszyć widoku
desktopowego.

## Jak pisać zmianę

- Klasy telefonu tylko za prefiksem: `max-sm:` albo `sm:` (np. `sm:hidden`
  dla elementu tylko na telefon).
- Zachowanie dotykowe w `app/globals.css` w bloku
  `@media (hover: none) and (pointer: coarse)` (i wariancie z
  `prefers-reduced-motion: reduce`).
- Bez zmian klas bez prefiksu w komponentach używanych na desktopie.
- Teksty dla klienta: bez długich myślników i bez plakietek nad nagłówkami,
  tylko nazwa „FaktWay” (`tests/unit/nazwa-produktu.test.ts`).

## Jak sprawdzić

1. Testy wizualne: `E2E_PORT=3132 pnpm test:wizualne` (`e2e/README.md`,
   sekcja „Testy wizualne”; najpierw `pnpm db:local`). Projekt
   `wizualne-desktop` (Chromium 1440x900) musi zostać zielony: to jest
   dowód, że Mac się nie zmienił. Czerwony `wizualne-iphone` przy zmianie
   na telefon jest spodziewany; obejrzyj różnicę w raporcie
   (`pnpm test:e2e:report`) i odśwież wzorzec telefonu
   (`E2E_PORT=3132 pnpm exec playwright test --project=wizualne-iphone
   --update-snapshots`) w tym samym PR.
2. Obchód telefonu (WebKit, iPhone; poziome przewijanie, ucięte przyciski,
   błędy strony, cele dotykowe): `e2e/README.md`, sekcja „Telefon”;
   ostatni wynik w `docs/qa/telefon-macierz.md`.
3. Ekran, którego nie ma w testach wizualnych: ten sam ekran w Chromium przy
   1440 px przed i po zmianie (te same elementy, te same wymiary; animacje na
   desktopie `animation-name: none`, gdzie były wyłączone).
4. W opisie PR: wynik testów wizualnych, zrzut telefonu i potwierdzenie, że
   desktop się nie zmienił.
