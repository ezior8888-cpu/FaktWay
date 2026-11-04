# Design spec — landing page FaktFlow (wyłącznie `/`)

Dokument opisuje **tylko** publiczną stronę główną produktu: routing, pliki, strukturę sekcji, komponenty, tokeny wizualne i granice techniczne. Nie obejmuje innych tras `(marketing)` (`/pricing`, `/blog`, stron „vs”, kalkulatora itd.), ani aplikacji zalogowanej.

---

## 1. URL i zakres

| Pojęcie | Wartość |
|--------|---------|
| Adres w przeglądarce | **`/`** (np. `https://domena.pl/`) |
| Plik strony | `app/(marketing)/page.tsx` |
| Grupa folderów `(marketing)` | **Nie** wchodzi do URL — to tylko organizacja kodu w App Routerze |
| Layout otaczający landing | `app/(marketing)/layout.tsx` (nagłówek, stopka, tło, `<main>`) |

Strona główna to **Server Component** (`page.tsx` bez `"use client"`). Interaktywne fragmenty są w osobnych komponentach klienckich (`'use client'`).

---

## 2. Mapa plików (landing + jego bezpośrednie zależności)

```
app/(marketing)/
  layout.tsx          # shell: tło, header sticky, <main>, footer
  page.tsx            # treść landing — wszystkie sekcje poniżej hero

components/marketing/
  marketing-ambient-background.tsx   # trzy animowane orby (fixed, pod treścią)
  feature-card.tsx
  testimonial-card.tsx
  savings-calculator-preview.tsx     # 'use client' — suwaki + kalkulacja
  faq-section.tsx                    # 'use client' — accordion FAQ

components/brand/
  faktway-logo.tsx      # logo FaktWay (FaktWayLogo) i sam znak (FaktWayMark), wbudowany SVG
  (ścieżki SVG: lib/brand/faktway-logo-paths.ts, generowane z docs/brand/logo/zrodla/aplikacja.py)

components/ui/
  button.tsx            # CTA: variant glass-primary | glass

app/globals.css       # klasy glass, animate-orb-*, font-display, itd.
```

`components/marketing/comparison-table.tsx` **nie** jest używany na landing (`/`).

---

## 3. Shell layoutu (`layout.tsx`)

### 3.1 Tło

- Kontener główny: `flex min-h-screen flex-col bg-background`.
- Warstwa dekoracyjna: `<MarketingAmbientBackground />` — `fixed inset-0 -z-10`, trzy duże plamy (`blur-[120px]`): niebieski, fiolet, zielony, z klasami `animate-orb-1` / `2` / `3` (keyframes `float-orb` w `globals.css`).

### 3.2 Header (sticky)

- `sticky top-0 z-40`, dolna krawędź `border-glass-border`, tło `bg-glass-white-strong backdrop-blur-glass-lg`.
- Lewa strona: link do `/` — `FaktflowMark` (`variant="header"`) + tekst „FaktFlow”.
- Nawigacja desktop (`md+`): Cennik, Porównania, Kalkulator, Blog (linki do innych tras marketingu).
- Prawa strona: „Zaloguj” → `/register` (ukryte na małym ekranie częściowo), CTA „Wypróbuj 30 dni” → `/register`.

### 3.3 Stopka

- `border-t border-glass-border`, to samo szkło co header.
- Siatka 2×2 / 4 kolumn na `md`: Produkt, Porównania, Zasoby, Prawo + pasek copyright.

### 3.4 Metadata layoutu

- `title` z `template: '%s | FaktFlow'` — wpływa na podstrony marketingu; **landing** nadpisuje tytuł własnym `metadata` w `page.tsx`.

---

## 4. Strona `page.tsx` — kolejność sekcji (od góry)

Wszystkie sekcje treści są w `<>` wewnątrz `<main>`. Typowy rytm: **`border-t border-glass-border py-24`** jako separator między blokami (pierwsza sekcja hero **nie** ma `border-t`).

### Sekcja A — Hero

- Kontener: `max-w-6xl px-6 text-center`, padding pionowy `pb-24 pt-16` (`lg:pb-32 lg:pt-24`).
- **Pill** (KSeF 2026): `rounded-full border-orange-500/20 bg-orange-500/10`, ikona `AlertCircle`.
- **H1**: `font-display text-5xl md:text-7xl`, druga część w `text-muted-foreground`.
- **Lead**: `text-xl max-w-2xl text-muted-foreground`.
- **CTA**: dwa `Button` — `glass-primary` → `/register`, `glass` → `/kalkulator-oszczednosci`; mikrocopy pod przyciskami (`text-xs`).
- **Placeholder „dashboard preview”**: karta `rounded-3xl border-glass-border bg-glass-white shadow-glass-lg backdrop-blur-glass`, środek `aspect-video`, gradient `bg-linear-to-br`, środek z `FaktflowMark variant="hero"` + tekst o ścieżce `/marketing/dashboard-preview.png`.

### Sekcja B — „Konkurencja zostaje w tyle”

- Nagłówek sekcji: etykieta `uppercase text-xs`, **H2** `font-display text-4xl md:text-5xl`.
- Siatka `md:grid-cols-2 gap-6`:
  - **`ProblemCard`** (inline w `page.tsx`): czerwona karta `border-red-500/20 bg-red-500/5`, lista z ikoną `X`.
  - **`SolutionCard`**: zielona karta `border-green-500/20 bg-green-500/5`, lista z `CheckCircle2`.

### Sekcja C — „5 funkcji…”

- Nagłówek jak wyżej.
- Siatka `md:grid-cols-2 lg:grid-cols-3 gap-6` — sześć **`FeatureCard`** (ikony Lucide: Camera, Shield, TrendingUp, Zap, FileText, Smartphone).

### Sekcja D — Kalkulator oszczędności

- `max-w-4xl`, nagłówek, potem **`SavingsCalculatorPreview`** (client).

### Sekcja E — Testimonials

- Siatka `md:grid-cols-3` — trzy **`TestimonialCard`** (gwiazdki, cytat, autor, rola).

### Sekcja F — Cennik ( uproszczony blok na landing )

- Wyśrodkowany blok: karta `inline-block rounded-3xl border-foreground/20 bg-foreground/5 p-10 shadow-glass-lg backdrop-blur-glass`.
- Cena **49 zł / mc**, lista benefitów z `CheckCircle2`, CTA `glass-primary` → `/register`.

### Sekcja G — FAQ

- **`FaqSection`** — osobna sekcja z własnym `border-t` (komponent zawiera pełny `<section>`).

### Sekcja H — zamknięcie (urgency + CTA)

- Krótki **H2** + akapit + `Button glass-primary` → `/register`, mikrocopy.

### Metadata strony (`page.tsx`)

- `title` i `description` ustawione na potrzeby SEO (KSeF 2026, KPiR, trial itd.).

---

## 5. Komponenty marketingowe (skrót kontraktu)

| Komponent | Client? | Rola |
|-----------|---------|------|
| `FeatureCard` | nie | Ikona Lucide, tytuł, opis, opcjonalny „proof” w zielonej pigułce |
| `TestimonialCard` | nie | Ocena gwiazdkami, cytat w cudzysłowie, autor, rola |
| `SavingsCalculatorPreview` | tak | Suwaki + wyliczenia + link do pełnego kalkulatora |
| `FaqSection` | tak | Lista FAQ z rozwijanymi odpowiedziami (stan lokalny) |
| `MarketingAmbientBackground` | nie | Tylko warstwa wizualna pod treścią |

---

## 6. System wizualny (co powielić w narzędziach zewnętrznych)

### Typografia

- **`font-display`** — nagłówki marketingowe (zdefiniowane w projekcie, Geist / heading).
- **`tracking-tighter-display`**, **`tracking-tighter-text`** — z `globals.css` / utility pod display.
- Treść pomocnicza: **`text-muted-foreground`**, rozmiary `text-xs` / `text-sm` / `text-xl`.

### „Szkło” i obramowania (Tailwind + custom)

Powtarzalne wzorce na kartach:

- `border-glass-border`, `bg-glass-white`, `backdrop-blur-glass`, `shadow-glass` / `shadow-glass-lg`
- Mocniejsze tło paska: `bg-glass-white-strong`, `backdrop-blur-glass-lg`

Semantyczne kolory stanów:

- Problem: `red-500/20` obramowanie, `red-500/5` tło, tekst `red-700` / `dark:text-red-400`.
- Rozwiązanie / sukces: analogicznie `green-500/…`.
- CTA pierwszorzędne: **`Button variant="glass-primary"`** (zielony akcent marki w motywie).

### Siatka i szerokości

- Główna kolumna treści: **`max-w-6xl mx-auto px-6`** (hero, większość sekcji).
- Węższe bloki (kalkulator, closing): **`max-w-4xl`** lub **`max-w-3xl`** (FAQ).

### Zaokrąglenia

- Karty i duże kontenery: **`rounded-3xl`**.
- Mniejsze elementy (ikony w kartach): `rounded-2xl`.

---

## 7. Zależności od reszty produktu (dla redesignu)

- Linki wyjściowe z landing: **`/register`**, **`/login`**, **`/kalkulator-oszczednosci`**, **`/pricing`**, **`/blog`**, **`/vs/*`**, **`/kontakt`**, **`/legal/*`**, zewnętrzna dokumentacja.
- Obraz marki: logo FaktWay z `components/brand/faktway-logo.tsx` (zestaw i instrukcja: `docs/brand/logo/`).
- Pełna zmiana wyglądu w Figma itd. **nie wymaga** zmiany URL — wdrożenie i tak trafia do `page.tsx` + ewentualnie `layout.tsx` i `components/marketing/*`.

---

## 8. Checklist wdrożenia po redesignie (zewnętrzne narzędzie → kod)

1. Zachować semantykę **H1 jeden na stronie** (hero).
2. Zachować **CTA** do `/register` (min. hero, cennik na dole, sekcja zamykająca).
3. Komponenty z **`useState`** zostawić jako client albo przenieść interakcję do nowych client wrapperów.
4. Sprawdzić **kontrast** i focus w formularzu FAQ / suwakach kalkulatora.
5. **`metadata`** w `page.tsx` zaktualizować pod nowy messaging.
6. Jeśli zmienia się tło globalne marketingu — edytować **`MarketingAmbientBackground`** lub klasy w `layout.tsx`, żeby blog/pricing dostały spójność.

---

*Ostatnia synchronizacja ze strukturą repo: sekcje i pliki zgodne z `app/(marketing)/page.tsx` oraz `layout.tsx`.*
