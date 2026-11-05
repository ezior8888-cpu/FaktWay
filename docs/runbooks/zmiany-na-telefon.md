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

1. Obchód telefonu (WebKit, iPhone; poziome przewijanie, ucięte przyciski,
   błędy strony, cele dotykowe): `e2e/README.md`, sekcja „Telefon”;
   ostatni wynik w `docs/qa/telefon-macierz.md`.
2. Mac bez zmian: ten sam ekran w Chromium przy 1440 px przed i po zmianie
   (te same elementy, te same wymiary; animacje na desktopie
   `animation-name: none`, gdzie były wyłączone).
3. W opisie PR: zrzut telefonu i potwierdzenie, że desktop się nie zmienił.
