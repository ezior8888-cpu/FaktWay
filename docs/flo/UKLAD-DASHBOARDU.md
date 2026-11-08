# Układ dashboardu po przebudowie — mapa dla obu torów

> **19.10.2026 (wieczór, decyzja Bartosza): FLO nie ma już na Pulpicie.**
> `/dashboard` to strona Finance szablonu Finora 1:1 na danych przykładowych
> (`components/dashboard/finora/*`). Blokada przewijania `html.ff-route-dashboard`
> i ukrywanie banera certyfikatu usunięte z `globals.css`. Miejsce FLO przyjdzie
> z projektu Claude Design. Opis niżej (slot FLO z E4, szyna) jest historyczny.

**Data:** 30 sierpnia 2026
**Napisał:** tor silnika (Bartosz)
**Dla kogo:** Masło i każdy model AI, który siada do `components/flo/*`,
`app/(dashboard)/flo/*` albo `app/(dashboard)/dashboard/_components/flo-*`.

---

## Po co ta zmiana

Plan budowy agenta FLO powstał na podstawie **zdjęcia prototypu**, nie stanu
aplikacji. Oba pliki planu mówią w wielu miejscach „układ z makiety”, „blok
z makiety”, „wygląda jak makieta” — i milcząco zakładają, że interfejs już tak
wygląda. **Nie wyglądał.** Do 29 sierpnia 2026 panel był ciemny (`#0d1117`),
akcent zielony (`#34d399`), a dashboard to były cztery karty KPI, podsumowanie
VAT i wykres — jednokolumnowo, bez miejsca na agenta.

Tor B miał więc kroki opisane słowami „jak w makiecie” i nie miał czego
dopasować. Ta przebudowa zdejmuje tę przeszkodę: stawia **ramę** z prototypu
i zostawia w niej **puste, otypowane gniazda** na to, co należy do toru B.

Nic z kroków 3–16 planu Masła nie zostało zrobione za niego.

---

## Co się zmieniło

| Obszar | Było | Jest |
|---|---|---|
| Motyw domyślny | ciemny (klasa `dark` zaszyta w `app/layout.tsx`) | **jasny**; ciemny pod przełącznikiem w nagłówku |
| Akcent panelu | emerald `#34d399` | **niebieski `#2563eb`** |
| Paleta jasna | nadpisywała ~25 z 94 tokenów — karty i tekst zostawały ciemne, czyli motyw jasny był **realnie zepsuty** | pełny komplet tokenów w bazie `.ff-dashboard`; ciemny to nadpisanie w `html.dark .ff-dashboard` |
| Dashboard | 4 karty KPI + podsumowanie VAT + wykres SVG, jedna kolumna | **kolumna agenta + prawa szyna z liczbami miesiąca** |
| Podsumowanie VAT i wykres | na dashboardzie | przeniesione na `/przeplywy` |
| Tytuł strony | `<h1>` w treści | dla `/dashboard` w pasku nagłówka; inne trasy bez zmian |

---

## Kto czego dotyka

Mapa własności z części IV.2 planu obowiązuje dalej, z **jedną zmianą**:

- **`app/globals.css` przechodzi do Bartosza.** Motywu nie da się odwrócić bez
  tego pliku. Zmiana jest jawna, opisana tutaj, w `DZIENNIK-BARTOSZ.md`
  i w części VIII planu Masła.
- **`lib/dashboard-nav-config.ts` zmieniony w etapie E2 planu Finora**
  (`docs/koordynacja/PLAN-FINORA.md`, §11 pkt 5) za potwierdzeniem Bartosza
  z 17.10.2026. Plik był Masła; nowe sekcje (Pulpit, Sprzedaż, Koszty,
  Księgowość), ikony Remix i reguły `isActiveNavPath` pilnuje
  `tests/unit/dashboard-nav-config.test.ts`. Dolny pasek (Flo / Faktury /
  Nowa / Miesiąc / Więcej) zostaje bez zmian pozycji. Etap E7 (20.10.2026)
  dopisał sekcję „Analizy” (`/analizy/sprzedaz`, `/analizy/koszty`,
  `prefetch: false`) razem ze stronami — zasada wpinania z §4 planu.
- **Shell jest na szablonie Finora** (plan Finora, E2):
  `app/(dashboard)/layout.tsx` oraz nowe `components/dashboard/app-sidebar.tsx`,
  `app-header.tsx`, `command-menu.tsx`, `profile-menu.tsx`, `footer.tsx`.
  Etykiety FLO w `lib/flo/functions/*` („Przeterminowane", „Skrzynka
  odbiorcza") zostają — to zadanie toru silnika, nie szkieletu.

Nadal wyłącznie Masła, nietknięte: `components/flo/*`, `app/(dashboard)/flo/*`,
`app/(dashboard)/settings/flo/*`, `content/flo/*`, `e2e/flo-*.spec.ts`,
`docs/flo/DZIENNIK-MASLO.md`.

---

## Dashboard JEST ekranem agenta

**Decyzja właściciela produktu z 30.08.2026, po południu.** Agent nie ma
osobnego ekranu — mieszka w dashboardzie, dokładnie jak na sierpniowej
makiecie. Wcześniej tego samego dnia było inaczej (dashboard pokazywał skrót,
pełny wątek stał na `/flo`); ten akapit jest nadrzędny.

| Trasa | Co się dzieje |
|---|---|
| `/dashboard` | od `lg` (E4 planu Finora): **slot FLO** o stałej wysokości `min(640px, 70dvh)` na pełnej szerokości — wątek agenta, prawa szyna: baner certyfikatu → „Zatwierdzone — czeka na wykonanie" → „Co Flo zrobił" — a pod nim **siatka kart Pulpitu** (Finora Finance). Poniżej `lg` sam wątek na pełny ekran, jak dotąd |
| `/flo` | **przekierowanie na `/dashboard`**, z zachowaniem parametrów zapytania |

`/flo` NIE zostało skasowane i nie wolno go kasować bez przejścia po
wszystkich odsyłaczach. Prowadzi tam osiem miejsc w kodzie: `actionUrls`
powiadomień push (`/flo#<id>`, `/flo?undo=<id>`), ścieżka paragonu
(`app/share-target/route.ts` → `/flo?paragon=`), cztery `revalidatePath('/flo')`
w akcjach serwerowych i stare zakładki. **Parametry zapytania muszą przeżyć
przekierowanie** — `?undo=` uruchamia cofnięcie, `?paragon=` pokazuje pasek
przetwarzania zdjęcia; zgubienie ich zamienia działającą ścieżkę w pustą
stronę bez śladu błędu.

Pozycja „Flo" zniknęła z menu: dashboard jest tym ekranem, a druga pozycja
prowadziłaby do tego samego miejsca przez przekierowanie.

### Kto czym jest w tej kompozycji

`app/(dashboard)/dashboard/page.tsx` (Bartosz) pobiera dane i składa ekran.
Nie zna wnętrza wątku. Renderuje `FloScreen` (Masło) i wstrzykuje do
**gniazda `aside`** baner certyfikatu (prop dodany do `FloScreen` 30.08.2026,
zmiana przez DODANIE, bez propa ekran zachowuje się jak wcześniej). Do E4 szła
tam też karta z liczbami miesiąca — od E4 liczby są w kartach pod slotem.

Nagłówek agenta jest wyłączony (`showHeader={false}`): panel ma własny pasek
tytułu, a dwa nagłówki jeden nad drugim to szum.

Pięć komponentów przeniesionych z `app/(dashboard)/flo/_components/` do
`components/flo/` (`flo-screen`, `flo-header`, `flo-composer`,
`flo-history-panel`, `flo-photo-banner`) — czyste `git mv`, zero zmian
w logice. Powód: były prywatne dla trasy, która stała się przekierowaniem.

`dashboard/_components/flo-card.tsx` (skrót agenta) **nie jest już nigdzie
montowany** — dashboard pokazuje pełny wątek. Plik zostaje, bo należy do
Masła i to jego decyzja, czy go skasować.

### Odporność na awarię silnika

Odczyt agenta (`listProposals` + `listScheduled`) jest w `try/catch`, a nie
za samą granicą błędu. Powód sprawdzony na żywo: pobranie dzieje się na
poziomie strony, więc rzucony wyjątek przewraca cały render, **zanim granica
zdąży się zamontować** — brak tabel FLO w bazie deweloperskiej wygasił w ten
sposób cały dashboard razem z liczbami miesiąca.

Przy awarii zwracamy `ok: false`, a NIE pustą listę. Pusta lista znaczy „nie
masz nic do zrobienia" i byłaby kłamstwem w chwili, gdy agent nie odpowiada —
cisza jest stanem zabronionym (własność W5).

`components/dashboard/section-error-boundary.tsx` zostaje jako druga warstwa,
na błędy powstające przy renderze.

Motyw: cały interfejs agenta stoi na tokenach `--ff-*`, bez ani jednego
zaszytego koloru i bez wariantów `dark:` (sprawdzone plik po pliku).
Biały motyw obejmuje go bez pracy po stronie toru B.

## Czego z makiety NIE WOLNO przepisać

Zdjęcie prototypu jest starsze niż część ustaleń i niesie trzy rzeczy, które
zostały **odrzucone**. Model AI kopiujący makietę „bo tak wygląda” wprowadzi
je z powrotem.

1. **Znacznik „TRYB 3”.** Poziomy autonomii zostały odrzucone przez właściciela
   produktu — część II.3 obu planów. Każdy klient dostaje identyczne zachowanie
   agenta. Żadnych trybów, poziomów, suwaka „jak bardzo samodzielny”.
2. **Podpis „Pracuje sam · informuje”.** To jest ta sama koncepcja innymi
   słowami. Zamiast tego: co agent robi, po ludzku — „Robi sam to, co da się
   cofnąć. Pyta przed każdą wysyłką.”
3. **„1 zadania dziś”.** Błąd odmiany przez liczebnik. Liczniki idą przez
   `countLabel(n, FLO_FORMS.zadanie)` z `components/flo/format.ts`, nigdy
   przez sklejanie napisu z liczbą.

Do tego jedna zmiana nazwy: panel z makiety **„CO FLO ZROBI DALEJ” nazywa się
„Zatwierdzone — czeka na wykonanie”**. Trafia tam wyłącznie to, na co człowiek
już kliknął, a każda pozycja niesie ślad tego kliknięcia (`approvedAtLabel`).
Przy pierwszej reklamacji „ja tego nie wysyłałem” to jest jedyny dowód, jaki
klient zobaczy. Przycisk „Wstrzymaj” jest hamulcem na coś, na co klient się
już zgodził — **nigdy mechanizmem zgody**.

---

## Odstępstwa od makiety po stronie ramy

- **Baner „Organizacja niezweryfikowana” został w layoucie**, nad obiema
  kolumnami, zamiast w prawej szynie. Powód: pilnuje WSZYSTKICH stron panelu,
  a w szynie zniknąłby z faktur, wydatków i skrzynki.
- **Wykres sprzedaży i podsumowanie VAT są na `/przeplywy`**, nie pod agentem.
  Dashboard przestał być zestawieniem.
- **Pozycja „Flo” w menu jest** — dodał ją Masło w swoim kroku 2, w swoim
  pliku `lib/dashboard-nav-config.ts`. Tor silnika tego pliku nie dotykał.

---

## Naprawa, która wyszła przy okazji

Stary dashboard filtrował faktury po `direction = 'issued'`. Kolumna
`invoices.direction` dopuszcza **wyłącznie `'outgoing' | 'incoming'`**
(`00001_initial_schema.sql:54`; migracja `00044_phase21_performance.sql:18`
ostrzega o tym wprost). Wszystkie cztery karty KPI pokazywały więc **zero**,
niezależnie od tego, ile faktur miał klient.

Nowe liczby idą przez `lib/dashboard/monthly-figures.ts` z poprawnym
`'outgoing'` i jawnym `tenantId` z `getPageContext()`.

**Ten sam błąd siedzi w dziewięciu innych plikach** (`lib/exports/*`,
`lib/admin/metrics.ts`, `lib/observability/business-metrics.ts`,
`lib/ksef/history-fetcher.ts` i dalej) — nie był w zakresie tej roboty
i czeka jako osobne zadanie.

---

## Gdzie co leży teraz

```
app/globals.css                              paleta (Bartosz od 30.08.2026)
lib/theme/theme.ts                           domyślny motyw = jasny
lib/dashboard-page-title.ts                  tytuł strony w pasku nagłówka
lib/dashboard/monthly-figures.ts             liczby miesiąca + seria wykresu
app/(dashboard)/layout.tsx                   shell na szablonie Finora (E2)
components/dashboard/app-sidebar.tsx         sidebar 16 rem / 3 rem zwinięty (E2)
components/dashboard/app-header.tsx          nagłówek 52 px (E2)
components/dashboard/command-menu.tsx        paleta poleceń ⌘K (E2)
components/dashboard/profile-menu.tsx        menu profilu (E2)
components/dashboard/footer.tsx              stopka (E2)
lib/dashboard-nav-config.ts                  menu: sekcje, ikony Remix (E2)
app/(dashboard)/_components/
  dashboard-page-heading.tsx                 tytuł w nagłówku
  dashboard-verification-banner.tsx          baner braku certyfikatu
app/(dashboard)/dashboard/page.tsx           RAMA: slot FLO + siatka Pulpitu (E4)
components/dashboard/pulpit/                 karty Pulpitu Finory i ich ładowarki (E4)
lib/dashboard/costs.ts                       koszty (jedna droga, §2.4 pkt 12)
lib/dashboard/rankings.ts                    produkty i klienci (§2.4 pkt 13)
lib/dashboard/receivables-aging.ts           należności według terminu
lib/dashboard/recent-invoices.ts             ostatnie faktury
lib/dashboard/pulpit-report.ts               karta „Ten miesiąc”
lib/dashboard/vat-limit.ts                   limit zwolnienia z VAT (na lib/flo/functions/vat-limit.ts)
app/(dashboard)/przeplywy/page.tsx           Przepływy = Cash Flow Finory (E5)
components/przeplywy/                        karty Przepływów i ich ładowarki (E5;
                                             dawne vat-summary-card, sales-chart-card
                                             i monthly-figures-card usunięte)
lib/dashboard/cash-flow.ts                   liczby /przeplywy „jak w KPiR”
lib/dashboard/inflows.ts                     wpływy według oznaczonych wpłat
lib/dashboard/cash-movements.ts              agregaty kart Przepływów

--- poniżej wszystko należy do Masła ---
app/(dashboard)/dashboard/_components/flo-card.tsx
app/(dashboard)/flo/                         ekran agenta z makiety
app/(dashboard)/settings/flo/                ustawienia agenta
components/flo/                              karty, warianty, podglądy
content/flo/                                 treści 32 rodzajów spraw
lib/i18n/plural.ts                           odmiana przez liczebnik
e2e/tests/flo-*.spec.ts                      testy przeglądarkowe
```

---

## TELEFON — wrzesień 2026

**Data:** 6 września 2026 · **Napisał:** tor silnika · **Dla kogo:** każdy, kto
siada do panelu na wąskim ekranie.

Do 6 września 2026 panel na telefonie **nie istniał**: proxy przekierowywało
każdy telefon na `/mobile` („aplikacja mobilna w przygotowaniu"). Ta sekcja
opisuje, co się zmieniło, i — ważniejsze — czego NIE wolno cofnąć.

### Przełącznik wpuszczania (zdjęty 2 listopada 2026)

Od FaktWay 1.0 panel jest dostępny na każdym telefonie. Przełącznika
`NEXT_PUBLIC_MOBILE_PANEL`, listy `NEXT_PUBLIC_MOBILE_PANEL_ALLOWLIST`
i pliku `lib/mobile-access.ts` już nie ma, a `proxy.ts` nie przekierowuje
telefonów na `/mobile`. Strona `/mobile` zostaje jako krótka instrukcja
dodania FaktWay do ekranu głównego. Obchód wszystkich ekranów na telefonie:
`e2e/tests/telefon-ekrany.spec.ts`, wyniki w `docs/qa/telefon-macierz.md`.

### Co gdzie mieszka na wąskim ekranie

| Element | Komputer (`lg`+) | Telefon |
|---|---|---|
| Nawigacja | sidebar 16 rem (od E2, szablon Finora) | dolny pasek: Flo · Faktury · **Nowa** · Miesiąc · Więcej |
| Tytuł w pasku | „Dashboard" + miesiąc | wordmark FaktFlow |
| Przełącznik organizacji | kartonik + rozwijka | pigułka „● Nazwa" + arkusz z dołu |
| Wylogowanie | ikona w pasku | arkusz „Więcej" |
| Pomoc | pływający bąbelek | arkusz „Więcej" (bąbelek siadał na „Zapisz") |
| Nagłówek agenta | ukryty (pasek ma tytuł) | **widoczny** — inaczej agent nigdzie się nie przedstawia |
| Prawa szyna | jest | **nie ma** |
| Liczby miesiąca | karty Pulpitu pod slotem FLO (od E4) | `/przeplywy`, zakładka „Miesiąc" |
| Zatwierdzone + historia | prawa szyna | odznaka w nagłówku Flo → arkusz |
| Baner certyfikatu | wariant szeroki, w szynie na `/dashboard` | wariant wąski na górze, do zamknięcia na dobę |

**Dlaczego szyna schodzi, a nie zjeżdża pod wątek.** Ekran agenta ma
zablokowaną wysokość (`html.ff-route-dashboard`), więc szyna pod wątkiem
lądowała poza ekranem i nie dało się do niej doscrollować. Panel
„Zatwierdzone" niesie `approvedAtLabel` — jedyny ślad zgody klienta — więc
schowanie go bez zastępnika było wykluczone. Stąd arkusz.

### Czego NADAL nie ma i nie będzie

Wszystko z sekcji „Czego z makiety NIE WOLNO przepisać" obowiązuje bez zmian.
Makieta telefonu pokazuje odznakę **„TRYB 3"** i podpis **„Pracuje sam ·
informuje"** — oba zostały odrzucone przez właściciela produktu i decyzja
została **potwierdzona ponownie 6 września 2026**, przy okazji tej przebudowy.
Nagłówek na telefonie ma awatar, imię, uczciwy podpis i dwie odznaki
(licznik spraw + kolejka). Żadnych trybów.

### Tokeny, o których trzeba wiedzieć

`--ff-safe-{t,b,l,r}` (bezpieczne obszary), `--ff-header-h` (telefon / od `lg`: 52 px, od E2),
`--ff-bottom-nav-h` (64/0 px), `--ff-sidebar-w` (0 / 16 rem, po zwinięciu 3 rem — od E2) — wszystkie
w `app/globals.css`, przełączane jednym `@media (min-width: 1024px)`.
Klasa `.ff-sticky-actions` zastąpiła dziesięć kopii `fixed bottom-0 …
lg:left-[280px]` (stara wartość; teraz szerokość sidebara z `--ff-sidebar-w`); jeśli zmienia się wysokość nawigacji, zmienia się w jednym
miejscu.

**Pułapka, która kosztowała pół dnia:** `.ff-route-template` miał
`animation: … both`. `both` utrzymuje `transform` po zakończeniu animacji,
a niezerowy `transform` tworzy blok zawierający dla `position: fixed` — więc
WSZYSTKIE przyklejone paski były przypięte do pudełka trasy, nie do okna
(zmierzone: 112 px nad dolną krawędzią). Jest `backwards`. Nie zmieniaj tego
z powrotem.

---

## PULPIT FINORY — październik 2026 (E4)

**Data:** 19 października 2026 · **Napisał:** sesja planu Finora (E4) ·
**Dla kogo:** Masło i każdy, kto siada do `/dashboard`.

Plan: `docs/koordynacja/PLAN-FINORA.md`, P1 i §2.4.

| Szerokość | Co jest na `/dashboard` |
|---|---|
| od `lg` | slot FLO na pełnej szerokości, kontener `h-[min(640px,70dvh)]` z `overflow-hidden` (wątek przewija się w sobie), pod nim siatka kart Finory; strona przewija się normalnie, stopka wraca |
| poniżej `lg` | bez zmian: pełnoekranowy FLO z blokadą przewijania; siatka ukryta (`hidden lg:grid`), liczby miesiąca na `/przeplywy` |

- **Blokada przewijania** (`html.ff-route-dashboard` w `globals.css`) działa
  od E4 tylko w `@media (max-width: 1023.98px)`. `DashboardRouteFlags` bez
  zmian — klasa jest ustawiana zawsze, CSS decyduje, czy blokuje.
- **`ff-flo-legacy`** obejmuje sam slot FLO (korzeń każdej z trzech gałęzi),
  nie siatkę kart. Karty stoją na presecie Finory.
- **Szyna** (`aside` w `FloScreen`) niesie tylko baner certyfikatu.
  `MonthlyFiguresCard` zniknął z Pulpitu, a w E5 także z `/przeplywy` (jego
  liczby są w karcie „Podsumowanie podatku VAT”).
  Reguła chowająca szeroki baner `.ff-shell-banner` od `lg` zostaje.
- **Awaria agenta:** tekst „Liczby miesiąca są w kartach poniżej” (od `lg`)
  albo „… w zakładce „Miesiąc”” (telefon) zamiast „Liczby miesiąca obok są
  aktualne”.
- **Strona nie liczy niczego na swoim poziomie.** Każda karta to osobny
  Server Component w `Suspense` + `SectionErrorBoundary`; wyjątek strażnika
  (EUR, środowisko KSeF) zabiera jedną kartę, slot FLO działa zawsze.
- Wnętrze FLO (`components/flo/*`) nietknięte. Jeśli wątek źle wygląda
  w wysokości 640 px, to sprawa dla Masła na punkcie kontrolnym.
