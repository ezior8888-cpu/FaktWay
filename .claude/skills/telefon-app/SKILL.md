---
name: telefon-app
description: Praca nad natywną aplikacją FaktWay w mobile/ (Expo, React Native). Czytaj przed każdym ekranem, komponentem albo zmianą wyglądu aplikacji na iPhone'a i Androida. Nie dotyczy PWA ani strony (tam telefon-review).
---

Zanim cokolwiek zmienisz w `mobile/`:

1. Przeczytaj `docs/mobile/ZASADY-DESIGNU.md` w całości i etap z „Następny krok” w `docs/koordynacja/PLAN-APLIKACJA-MOBILNA.md`.
2. Komponenty bazowe są w `mobile/src/komponenty/` (`Tekst`, `EkranListy`, `Sekcja`, `Wiersz`, `StanPusty`), kolory, typografia i odstępy w `mobile/src/wyglad/`. Nowy ekran składasz z nich; nie wpisujesz kolorów, rozmiarów czcionek ani odstępów na sztywno.
3. Przed wyborem komponentu sprawdź skille Expo: `expo-ui` (natywne SwiftUI i Compose), `expo-router` (zakładki, stos, arkusze, pasek), `expo-native-ui`, `expo-animation`, `expo-design-system`. To kopie z github.com/expo/skills (MIT) z commita `a9e5bd3fa00b` dla SDK 58; przy aktualizacji SDK pobierz nowsze.
4. Wersje API Expo sprawdzaj w typach w `mobile/node_modules` albo w dokumentacji dla SDK z `mobile/package.json`, nie z pamięci.
5. Zależności dodajesz przez `npx expo install` w `mobile/` (własny workspace pnpm, główny lockfile się nie zmienia).
6. Weryfikacja ekranu: `pnpm run sprawdz` w `mobile/` (typy i eslint), potem zrzuty z symulatora według checklisty z sekcji 12 zasad: jasny i ciemny, iPhone 17e i iPhone 18 Pro Max, największy tekst. Zrzuty dołączasz do PR.
7. Mac ma 16 GB: budowanie w Xcode, `pnpm build` strony i Supabase w Colimie nigdy razem.
