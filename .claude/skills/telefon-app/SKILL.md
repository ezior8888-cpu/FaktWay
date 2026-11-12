---
name: telefon-app
description: Praca nad natywną aplikacją FaktWay w mobile/ (Expo, React Native). Czytaj przed każdym ekranem, komponentem albo zmianą wyglądu aplikacji na iPhone'a i Androida. Nie dotyczy PWA ani strony (tam telefon-review).
---

Zanim cokolwiek zmienisz w `mobile/`:

1. Przeczytaj `docs/mobile/ZASADY-DESIGNU.md` w całości i etap z „Następny krok” w `docs/koordynacja/PLAN-APLIKACJA-MOBILNA.md`.
2. Komponenty bazowe są w `mobile/src/komponenty/` (`Tekst`, `EkranListy`, `Sekcja`, `Wiersz`, `StanPusty`), kolory, typografia i odstępy w `mobile/src/wyglad/`. Nowy ekran składasz z nich; nie wpisujesz kolorów, rozmiarów czcionek ani odstępów na sztywno.
3. Zanim zaprojektujesz albo przerobisz ekran, sprawdź jego sekcję w `docs/mobile/WZORCE-MOBBIN.md` i zrób 2 do 4 wyszukiwań w Mobbin (narzędzia MCP `search_screens` i `search_flows`, platforma iOS, aplikacje biznesowe i fintech). Bierzesz układ, przepływ i stany; wzór całej aplikacji to Copilot i Revolut Business (D14), wygląd według sekcji 1 zasad (D12 i D15). Link do wzorca idzie do opisu PR, zrzuty z Mobbin nigdy do repo.
4. Przed wyborem komponentu sprawdź skille Expo: `expo-ui` (natywne SwiftUI i Compose), `expo-router` (zakładki, stos, arkusze, pasek), `expo-native-ui`, `expo-animation`, `expo-design-system`. To kopie z github.com/expo/skills (MIT) z commita `a9e5bd3fa00b` dla SDK 58; przy aktualizacji SDK pobierz nowsze.
5. Wersje API Expo sprawdzaj w typach w `mobile/node_modules` albo w dokumentacji dla SDK z `mobile/package.json`, nie z pamięci.
6. Zależności dodajesz przez `npx expo install` w `mobile/` (własny workspace pnpm, główny lockfile się nie zmienia).
7. Weryfikacja ekranu: `pnpm run sprawdz` w `mobile/` (typy i eslint), potem zrzuty z symulatora według checklisty z sekcji 12 zasad: jasny i ciemny, iPhone 17e i iPhone 18 Pro Max, największy tekst. Zrzuty dołączasz do PR.
8. Mac ma 16 GB: budowanie w Xcode, `pnpm build` strony i Supabase w Colimie nigdy razem.
