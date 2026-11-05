# 🚚 PRZEPROWADZKA NA HETZNER — kompletna instrukcja krok po kroku

> Dla: Bartosz (bez doświadczenia z Linuxem). Każdy krok tłumaczony od zera.
> Stan wyjściowy: apka na Vercel + Supabase Cloud + Inngest + Upstash + R2,
> **zero klientów** — możemy się przeprowadzać bez okna serwisowego i bez stresu.
> Kod jest już przygotowany: `Dockerfile`, tryb `standalone`, przełącznik
> `R2_FORCE_PATH_STYLE` pod MinIO (zrobione w sesji 24 lipca 2026).

---

## 0. MAPA: co przenosimy, co zostaje

| Dziś (SaaS) | Po przeprowadzce | Etap |
|---|---|---|
| Vercel (hosting) | Coolify na Twoim serwerze | 2 |
| **Supabase Cloud — RACHUNEK** (baza + logowanie) | **Supabase — DARMOWY KOD** self-hosted na `db-1` (Coolify) | 3 |
| Upstash Redis (cache, limity) | Redis/Valkey + SRH (Coolify) | 4 |
| Cloudflare R2 (pliki XML/PDF) | MinIO (Coolify) | 5 |
| Sentry (błędy) | **zostaje na razie** (darmowy plan); GlitchTip dopiero po Rescale ops-1 | 6 |
| Inngest (36 jobów w tle) | pg-boss (kod pisze AI) | 7 |
| — | Uptime Kuma (monitoring uptime) | 6 |
| PostHog Cloud EU (analityka) | **ZOSTAJE** (free tier; self-host dopiero przy dużej skali) | — |
| Stripe, Resend, Anthropic, Cloudflare DNS/CDN/Turnstile, GitHub | **ZOSTAJĄ NA ZAWSZE** | — |

**Kolejność jest nieprzypadkowa**: najpierw hosting (najłatwiejszy do cofnięcia),
na końcu joby (najwięcej kodu). Po każdym etapie apka jest w 100% sprawna —
nigdy nie rozgrzebujemy dwóch rzeczy naraz.

### ⚠️ Ważne rozgraniczenie: „Supabase" w dokumentach NIE oznacza rachunku

„Supabase" to dwie różne rzeczy, i to jest źródło częstej pomyłki:

1. **Supabase Cloud** — firma, która wystawia rachunek (Free → Pro 25 $/mc
   → Team 599 $/mc + dopłaty za compute/ruch, gdy rośniesz).
2. **Supabase (open source)** — darmowy silnik: Postgres + logowanie
   (GoTrue) + REST API + Storage + Realtime. Ta sama firma oddaje ten kod
   za darmo, żebyś mógł postawić go na WŁASNYM serwerze.

Ta migracja bierze #2 i stawia je na Twoim `db-1`, **całkowicie rezygnując
z #1**. Nazwa „Supabase" zostaje w kodzie/dokumentach (bo to wciąż ten sam
silnik — tak jak mówisz „używam Postgresa" niezależnie, czy jest na AWS
czy w Twojej piwnicy), ale **rachunek do Supabase Inc. znika w Etapie 9**
(Pause → Delete). Koszt serwera `db-1`, który już policzyłeś (§1.6/§1.7),
**zastępuje** rachunek Supabase Cloud w 100% — nie dochodzi do niego.

Konkretnie, ile realnie oszczędzasz na samej bazie (ceny sprawdzone
24 lipca 2026 na supabase.com/pricing):

| Skala | Supabase Cloud | Self-hosted (Twój `db-1`) |
|---|---|---|
| Teraz / dev | Free (0 $) lub Pro 25 $/mc | 0 $ osobno — to `db-1`, już policzony |
| Alpha, kilkaset userów | Pro 25 $ + compute Medium 60 $ = **85 $/mc** | ten sam `db-1`, ewentualny Rescale |
| ~2 000 klientów | Pro + compute Large/XL 110-210 $ = **135-235 $/mc** | Rescale `db-1` — jednorazowy koszt serwera |
| ~10 000 klientów | Team 599 $ + compute 2XL 410 $ ≈ **1000 $/mc** (~4400 zł) | `db-1` ~36-85 €/mc (~155-370 zł) |

(Supabase Cloud dolicza dodatkowo 0,125 $/GB ponad 8 GB bazy i 0,09 $/GB
ponad 250 GB transferu — na własnym serwerze dysk i transfer są wliczone
w cenę, więc tych pozycji w ogóle nie ma.)

### 💰 To samo porównanie, ale dla CAŁEGO stacku (nie tylko Supabase)

Ceny sprawdzone na żywo 24 lipca 2026 na stronach dostawców. Usługi
usage-based (Vercel, Upstash, Inngest) mają szersze widełki niż Supabase,
bo ich rachunek zależy od realnego ruchu, nie tylko wybranego planu — nie
mam telemetrii Twojego konta, więc to orientacyjne szacunki dla typowego
wzorca użycia apki do fakturowania (sesyjny ruch B2B, nie ciągły streaming).

| Usługa (dziś) | Teraz / dev | Alpha (~kilkaset) | ~2 000 klientów | ~10 000 klientów |
|---|---|---|---|---|
| **Vercel** (Hobby $0 / Pro $20+usage) | $0-20 | $30-40 | $80-140 | $220-420 |
| **Supabase Cloud** (patrz tabela wyżej) | $0-25 | $85 | $135-235 | ~$1 000 |
| **Upstash Redis** (Free / Fixed) | $0 | $0-10 | $20-100 | $100-800 |
| **Cloudflare R2** (archiwum XML 10 lat, tylko rośnie) | $0 | $0-5 | $10-30 | $50-150 |
| **Sentry** (Free / Team / Business) | $0 | $0-26 | $80 | $150-300 |
| **Inngest** (36 jobów, submit+UPO+OCR+maile) | $0 | $0-99 | $150-400 | $300-1500 |
| **PostHog** — zostaje, nie migrujemy | $0 | $0 | $0 | $0-kilkadziesiąt |
| **RAZEM (bez PostHog, który zostaje tak samo)** | **~$0-70** (~0-300 zł) | **~$120-260** (~530-1150 zł) | **~$475-905** (~2100-4000 zł) | **~$1800-4200** (~7900-18500 zł) |

| | Teraz / dev | Alpha | ~2 000 | ~10 000 |
|---|---|---|---|---|
| **Hetzner (wszystkie 3 serwery, §1.6/§1.7/§11)** | **~23-68 €** (~100-290 zł) | **~45 €** (~195 zł) | **~55 €** (~240 zł) | **~140-170 €** (~610-740 zł) |

**Dlaczego po stronie Hetznera nie ma osobnych wierszy per usługa:** to
jest właśnie sedno oszczędności — 6 osobnych liczników, które rosną z
KAŻDYM requestem/eventem/GB, zastępujesz TRZEMA serwerami o stałej,
przewidywalnej cenie, która rośnie tylko wtedy, gdy Ty klikniesz Rescale.
Nie dostaniesz niespodziewanie wyższego rachunku, bo miesiąc był ruchliwy.

**Szeroki rozstrzał widełek przy 10 000 klientów** (zwłaszcza Inngest i
Upstash) bierze się z tego, że te usługi liczą za KAŻDE wykonanie/komendę
— realny koszt zależy od tego, ile faktur/maili/OCR-ów Twoi klienci
faktycznie generują, nie tylko od liczby kont. Migrując je (Etapy 4 i 7),
usuwasz tę niepewność całkowicie — pg-boss na własnym Postgresie i
Redis/Valkey na własnym serwerze kosztują zero-krańcowo niezależnie od
wolumenu.

**Plan awaryjny (zawsze ten sam):** dopóki nie wykonasz Etapu 9 (sprzątanie),
stare usługi działają równolegle. Cofnięcie = przestawienie DNS-a w Cloudflare
z powrotem na Vercel (5 minut) i przywrócenie starych wartości env.

---

## 1. ZAKUPY — co dokładnie kupić (Etap 0, ~1 godzina klikania)

### 1.1 Konto Hetzner

1. Wejdź na `https://console.hetzner.com` → **Sign up**.
2. Rejestrujesz się jako osoba prywatna (firma dojdzie później — wtedy
   zaktualizujesz dane i po nadaniu VAT-UE ceny będą netto; do tego czasu
   Hetzner dolicza polski VAT 23%).
3. Hetzner może poprosić o weryfikację (dokument/karta) — to normalne.
4. W konsoli utwórz **projekt** o nazwie `faktflow`.

### 1.2 Klucz SSH (Twój "klucz do drzwi" serwera)

Masz już wygenerowany klucz z fazy M0 (`~/.ssh/hetzner_faktflow_ed25519`).
Jeśli nie — w Terminalu na Macu:

```bash
bash scripts/hetzner/keygen.sh
```

Potem: Hetzner Console → projekt `faktflow` → **Security → SSH Keys →
Add SSH key** → wklej zawartość pliku `.pub`:

```bash
cat ~/.ssh/hetzner_faktflow_ed25519.pub | pbcopy
```

(`pbcopy` = skopiowane do schowka, tylko wklej Cmd+V).

### 1.3 Serwery — dokładna specyfikacja startowa

Hetzner Console → **Servers → Add Server**. Dla KAŻDEGO z trzech serwerów:

- **Location:** `Nuremberg (nbg1)` — Niemcy, UE (RODO OK), a do tego BLIŻEJ
  Polski niż Helsinki (niższy ping). ⚠️ **Dostępność zmienia się z dnia na
  dzień** — Falkenstein bywa wyprzedany, Helsinki w chwili pisania tego
  dokumentu nie miało wcale linii CX, Nuremberg miało CX23, ale już nie
  CX33/CX43/CX53. **Zanim klikniesz zakup, sam sprawdź w konsoli, co
  faktycznie jest dostępne w wybranej lokalizacji** — poniższa tabela to
  stan na 24 lipca 2026, ceny/dostępność mogą się nieznacznie różnić.
  Po wyborze lokalizacji trzymaj się jej konsekwentnie dla WSZYSTKICH
  trzech serwerów — gadają wewnętrznie tylko w obrębie jednej lokalizacji.
- **Image:** `Ubuntu 24.04` (LTS — wsparcie do 2029).
- **Type → zakładka Shared vCPU → architektura `x86 (Intel/AMD)`**.
  ⚠️ NIE wybieraj `Arm64 (Ampere)`, mimo że jest tańszy: część obrazów
  Dockera (m.in. w stacku Supabase) nie ma wersji ARM, a przejście
  ARM → x86 później wymaga postawienia serwera OD NOWA. x86 zostawia
  otwartą drogę do mocniejszych typów.
- **Networking:** zostaw Public IPv4 ✅ + IPv6 ✅.
- **SSH keys:** zaznacz swój klucz `hetzner_faktflow` ✅ (KRYTYCZNE — bez
  tego dostaniesz hasło root mailem, czego nie chcemy).
- **Cloud config / Volumes / Placement:** pomiń.

| Nazwa serwera | Typ (wybierz z listy) | Spec | Cena/mc **z VAT** | Do czego |
|---|---|---|---|---|
| `app-1` | **CX23** | 2 vCPU / 4 GB RAM / 40 GB SSD | 6,75 € | aplikacja Next.js + workery jobów |
| `ops-1` | **CX23** | 2 vCPU / 4 GB / 40 GB | 6,75 € | Coolify + Redis + MinIO + Uptime Kuma |
| `db-1` | **CPX32** | 4 vCPU / 8 GB / 160 GB | 43,65 € | Supabase (baza + logowanie) |

> **Stan faktyczny (23.10.2026):** Redis stoi na `app-1`, nie na `ops-1` (sekcja 5).

**Dlaczego `db-1` skacze cenowo, a nie tylko specyfikacją:** linia CX33
(dawny odpowiednik 8 GB w tańszej serii CX) była w chwili zakupu wyprzedana
we WSZYSTKICH sprawdzonych lokalizacjach — jedyna dostępna opcja z 8 GB to
CPX32 z droższej serii CPX. To nie pomyłka w tabeli, to realny brak tańszej
alternatywy. **Gdy w kolejnych tygodniach CX33 wróci do sprzedaży**
(magazyn Hetznera się zmienia), możesz zrobić Rescale `db-1` w dół na CX33
i płacić ~10 € zamiast ~44 € za te same 8 GB — sprawdzaj to od czasu do
czasu, zero kosztu za samo sprawdzenie.

Dlaczego `db-1` w ogóle musi mieć 8 GB, a nie 4 GB jak reszta: stack
Supabase to kilkanaście kontenerów (Postgres, GoTrue, PostgREST, Kong,
Studio, Realtime, analytics) i na 4 GB RAM potrafi się zadławić. To jedyne
miejsce, gdzie NIE oszczędzamy kosztem stabilności.

⚠️ **Dla app-1 i ops-1 NIE kupuj CPX12** (1 vCPU / 2 GB za 14,13 €) mimo że
wygląda na „budżetową" opcję — CX23 (2 vCPU / 4 GB) kosztuje mniej (6,75 €)
i ma więcej mocy. CPX ma sens WYŁĄCZNIE tam, gdzie potrzebujesz więcej RAM
niż oferuje CX23, czyli tylko przy `db-1`.

Do tego przy `db-1` po utworzeniu włącz **Backups** (zakładka Backups →
Enable): +20% ceny serwera (~8,73 € przy CPX32; mniej, jeśli później
zrobisz Rescale na CX33) — Hetzner sam robi 7 automatycznych snapshotów.
To Twoja siatka bezpieczeństwa numer 1.

### 1.4 Sieć prywatna i firewall (darmowe)

1. **Networks → Create network**: nazwa `faktflow-net`, zakres domyślny
   (10.0.0.0/16). Potem wejdź w każdy serwer → Networking → **Attach to
   network** → `faktflow-net`. Serwery dostaną prywatne IP (10.0.0.x) i będą
   gadać między sobą wewnętrznie — szybko i bez wystawiania baz na świat.
2. **Firewalls → Create firewall**: nazwa `faktflow-fw`, reguły **Inbound**:

   | Protokół | Port | Źródło | Po co |
   |---|---|---|---|
   | TCP | 22 | TWOJE IP (wpisz `https://ifconfig.me` w przeglądarce) | SSH tylko dla Ciebie |
   | TCP | 80 | Any IPv4/IPv6 | HTTP (certyfikaty + redirect) |
   | TCP | 443 | Any IPv4/IPv6 | HTTPS (apka) |
   | TCP | 8000 | TWOJE IP | panel Coolify |

   Outbound zostaw puste (= wszystko dozwolone). Przypnij firewall do
   wszystkich 3 serwerów (Apply to → Resources). Ruch w sieci prywatnej
   NIE przechodzi przez ten firewall — i dobrze.

   ⚠️ Masz zmienne IP w domu? Gdy SSH przestanie działać, zaktualizuj
   regułę portu 22 na nowe IP w konsoli Hetzner (30 sekund).

### 1.5 Storage Box (magazyn na backupy poza serwerami) — ODŁÓŻ

Hetzner Console → **Storage Boxes → Order** → **BX11** (1 TB, ~5 €/mc z VAT),
ta sama lokalizacja co serwery (**Nuremberg**, jeśli dostępna — Storage Boxy
mają osobną pulę magazynową niż serwery Cloud, więc może różnić się od
lokalizacji `app-1`/`db-1`/`ops-1`; to nieistotne, bo łączysz się z nim
przez internet, nie sieć prywatną). Zapisz dane dostępowe (Etap 8).

**Na teraz możesz to POMINĄĆ.** Dopóki nie masz prawdziwych klientów, dwie
warstwy backupu wystarczą: automatyczne snapshoty Hetznera na `db-1` +
codzienny zrzut aplikacyjny do MinIO. Storage Box (trzecia warstwa, poza
serwerami) dokup w dniu, w którym zarejestruje się pierwszy realny klient —
zamówienie zajmuje 2 minuty i nie wymaga niczego przebudowywać.

### 1.6 Rachunek startowy

| Pozycja | €/mc z VAT |
|---|---|
| app-1 (CX23) | 6,75 |
| ops-1 (CX23) | 6,75 |
| db-1 (CPX32 — CX33 chwilowo wyprzedane) | 43,65 |
| 3× publiczne IPv4 | 1,85 |
| Backups na db-1 (20% z 43,65) | 8,73 |
| **RAZEM** | **~67,73 € ≈ 290 zł/mc** |

To więcej niż pierwotnie liczyłem (wtedy zakładałem CX33 za 10,44 € na
`db-1`) — różnicę robi wyłącznie chwilowy brak magazynowy tańszej linii CX
z 8 GB. **To nie jest cena docelowa**, tylko cena PRZY OBECNYM stanie
magazynu: jak tylko CX33 wróci do sprzedaży (sprawdzaj raz na tydzień przy
okazji cotygodniowego przeglądu, [PRACA-I-NAUKA-HETZNER.md](PRACA-I-NAUKA-HETZNER.md)
§1), zrób Rescale `db-1` w dół — spadniesz do ~34 €/mc bez żadnej utraty
danych. Nawet ~68 €/mc to i tak ułamek kosztu obecnego stacku SaaS.

(Ceny w konsoli Hetznera są **z 23% VAT**, bo rejestrujesz się jako osoba
prywatna. Po założeniu firmy i podaniu VAT-UE rachunek spadnie o ~19% —
Hetzner przestanie doliczać VAT.)

### 1.7 WARIANT BUDŻETOWY — jeśli 68 €/mc to teraz za dużo

**Tak, da się zacząć od 3× CX23 (ten sam tani typ na wszystkie trzy
serwery).** Dla testów na 5-10 osób to rozsądny kompromis — nie jest to
„robienie na oszczędności kosztem bezpieczeństwa", tylko świadomy wybór z
jasnym momentem, kiedy to zmienić.

| Pozycja | €/mc z VAT |
|---|---|
| app-1 (CX23, 2/4/40) | 6,75 |
| ops-1 (CX23, 2/4/40) | 6,75 |
| db-1 (CX23, 2/4/40) | 6,75 |
| 3× publiczne IPv4 | 1,85 |
| Backups na db-1 (zostaw — 20% z 6,75 to grosze) | 1,35 |
| **RAZEM** | **~23,45 € ≈ 100 zł/mc** |

**Co to oznacza w praktyce:** stack Supabase (Postgres + GoTrue + PostgREST
+ Kong + Studio + Realtime + Storage + Meta + Analytics/Logflare) na 4 GB
RAM jest CIASNY, ale wykonalny przy Twoim ruchu testowym (kilku userów,
sporadyczne akcje, nie load test). Dwie rzeczy, które musisz zrobić, żeby
to działało stabilnie:

1. **Swap 4 GB na `db-1` — TAKA SAMA komenda jak dla `app-1` w §2.4**, tylko
   uruchomiona na serwerze `db-1` zamiast `app-1`. Zrób to na WSZYSTKICH
   trzech serwerach budżetowych, nie tylko na app-1.
2. **Zawór bezpieczeństwa: `analytics` (Logflare) to największy pojedynczy
   pożeracz RAM-u w stacku Supabase** (własny drugi silnik bazy danych do
   logów, potrafi zjeść 500 MB-1 GB). Nie musisz nic wyłączać z góry —
   zrób to TYLKO jeśli zobaczysz problem (patrz sygnały niżej). Wtedy na
   `db-1`:

   ```bash
   docker ps   # znajdź nazwę kontenera zawierającą "analytics"
   docker stop NAZWA_KONTENERA
   docker update --restart=no NAZWA_KONTENERA
   ```

   Efekt uboczny: zakładka „Logs" w Supabase Studio przestanie działać —
   bez znaczenia, bo błędy aplikacji i tak widzisz w Sentry.

**Sygnały, że trzeba przestać czekać i zrobić Rescale `db-1` w górę
(priorytet nr 1 przed czymkolwiek innym):**
- `free -h` na `db-1` pokazuje regularnie < 200 MB wolnego RAM-u,
- `docker ps` pokazuje kontener ciągle w stanie „Restarting",
- `dmesg | grep -i kill` pokazuje wpisy „Out of memory: Killed process",
- apka zaczyna być zauważalnie wolniejsza / rzuca losowe błędy 500 przy
  logowaniu lub zapisie faktury.

**Twarda zasada:** zanim zaprosisz PIERWSZEGO prawdziwego (płacącego)
klienta — niezależnie od tego, czy zobaczysz powyższe sygnały — zrób
Rescale `db-1` w górę (CPX32 lub CX33, cokolwiek akurat dostępne, §11).
Testy z 5-10 zaufanymi osobami mogą przeżyć na budżecie; realny biznes nie
powinien.

Reszta tej instrukcji (Etapy 2-9) jest IDENTYCZNA niezależnie od tego, czy
wybierzesz wariant z CPX32 czy budżetowy z samym CX23 — różnica to
wyłącznie typ serwera `db-1` w momencie zakupu i dwie rzeczy opisane wyżej.

---

## 2. ETAP 1 — Coolify, czyli Twój "własny Vercel" (~30 min)

Coolify to panel www, który zarządza deploymentami za Ciebie — Ty klikasz,
on robi Dockera, certyfikaty SSL, restarty. Dzięki niemu 95% pracy NIE
wymaga terminala.

### 2.1 Zaloguj się na ops-1

W Terminalu na Macu (IP publiczne znajdziesz w konsoli Hetzner przy serwerze):

```bash
ssh -i ~/.ssh/hetzner_faktflow_ed25519 root@IP_OPS-1
```

Przy pierwszym razie zapyta „fingerprint... yes/no" → wpisz `yes`.
Jesteś w środku — widzisz znak zachęty `root@ops-1:~#`. To jest terminal
TEGO serwera; wszystko co wpiszesz, dzieje się tam, nie na Twoim Macu.

### 2.2 Aktualizacja systemu + instalacja Coolify (2 komendy)

```bash
apt update && apt upgrade -y
```

(`apt` = sklep z oprogramowaniem Ubuntu; update odświeża katalog, upgrade
instaluje poprawki. Może mielić 2-5 min. Jeśli wyskoczy różowy ekran
z pytaniem o restart usług — Enter na OK.)

```bash
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash
```

(Oficjalny instalator Coolify — stawia Dockera i panel. ~3-5 min.)

Na końcu wypisze adres: `http://IP_OPS-1:8000`. Otwórz go w przeglądarce →
utwórz konto administratora (Twój mail + MOCNE hasło do 1Password).

### 2.3 Podepnij pozostałe serwery do Coolify

W panelu Coolify: **Servers → Add Server**:
- Name: `app-1`, IP: **prywatne IP app-1** (10.0.0.x — z zakładki Networking
  w Hetzner), user `root`, port 22.
- Coolify pokaże swój klucz publiczny → musisz go dodać na app-1. Z Maca:

```bash
ssh -i ~/.ssh/hetzner_faktflow_ed25519 root@IP_PUBLICZNE_APP-1 \
  "echo 'TU_WKLEJ_KLUCZ_Z_COOLIFY' >> ~/.ssh/authorized_keys"
```

- Kliknij **Validate & Install** — Coolify sam zainstaluje Dockera na app-1.
- Powtórz identycznie dla `db-1`.

### 2.4 Swap (bufor pamięci — 2 minuty, ratuje przed OOM)

Build aplikacji Next.js potrafi chwilowo zjeść 3-4 GB RAM. Swap to
„awaryjna pamięć na dysku" — wolniejsza, ale zapobiega zabiciu procesu
przez system, gdy RAM się skończy. Zaloguj się na serwer i wklej blok
(całość naraz):

```bash
fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab && free -h
```

Po komendzie `free -h` w wierszu `Swap:` zobaczysz `4,0Gi` — gotowe.
(Znaczenie: utwórz plik 4 GB → zabezpiecz uprawnienia → sformatuj jako swap
→ włącz → dopisz do listy startowej, żeby przetrwał restart.)

**Zrób to na `app-1` ZAWSZE** (build Next.js tego wymaga niezależnie od
wybranego wariantu kosztowego). **Jeśli jedziesz na wariancie budżetowym
(§1.7, `db-1` też na CX23)** — zrób DOKŁADNIE tę samą komendę również na
`db-1` (stack Supabase na 4 GB potrzebuje tego bufora jeszcze bardziej niż
sam build). Na `ops-1` swap jest opcjonalny (MinIO/Kuma są lekkie; Redis stoi na `app-1`, sekcja 5),
ale nie zaszkodzi zrobić go wszędzie — to 2 minuty i zero minusów.

✅ **Weryfikacja etapu:** wszystkie 3 serwery w Coolify świecą na zielono,
a `free -h` na każdym z nich, na którym zrobiłeś swap, pokazuje `4,0Gi`.

---

## 3. ETAP 2 — aplikacja na Hetznerze (~1-2 h, apka wciąż na starej bazie!)

Kluczowa sztuczka: przenosimy SAM hosting. Apka na Hetznerze łączy się
nadal z Supabase Cloud, Upstash, Inngest — więc jeśli coś pójdzie źle,
nic nie tracisz.

### 3.1 Projekt w Coolify

1. **Projects → Add** → `faktflow` → środowisko `production`.
2. **Add Resource → Application → GitHub** (Private Repository with GitHub App)
   → autoryzuj repo `ksef-saas` → gałąź `main` → **serwer: app-1**.
3. **Build Pack: Dockerfile** (jest w repo, gotowy). Port: `3000`.

### 3.2 Zmienne środowiskowe

Zakładka **Environment Variables** aplikacji. Przeklej WSZYSTKIE zmienne
z Vercela (Vercel → Settings → Environment Variables). Dwa wyjątki/uwagi:

- Każdą zmienną zaczynającą się od `NEXT_PUBLIC_` **oznacz jako „Build
  Variable"** (checkbox) — one są wypiekane w JS podczas builda.
- `SENTRY_AUTH_TOKEN` też jako Build Variable (opcjonalny).
- NIE przenoś zmiennych `VERCEL_*` (nie istnieją poza Vercelem — i dobrze;
  gate `lib/security/environment.ts` jest na to przygotowany, ale sprawdź,
  że na Hetznerze ustawiasz `NEXT_PUBLIC_APP_ENV=production`).
- ⚠️ **Sprawdź konkretnie `NEXT_PUBLIC_APP_URL`.** Jeśli kopiujesz z
  jakiegokolwiek starego backupu `.env.local`, łatwo przypadkiem wkleić
  `http://localhost:3000` (wartość do pracy lokalnej) zamiast prawdziwego
  adresu produkcyjnego. Musi być: **`https://faktflow.pl`** (patrz §3.3 —
  to jest prawdziwa domena produkcyjna, nie `app.faktflow.pl`).

### 3.3 Domena + Cloudflare (uwaga, jedyny podchwytliwy moment)

**Zanim zaczniesz: prawdziwa domena produkcyjna to `faktflow.pl` (goła,
bez „app.") + `www.faktflow.pl`** — sprawdziłem to bezpośrednio w Vercelu
(`vercel alias ls`). To jeden Next.js, który serwuje i stronę marketingową,
i panel z tego samego adresu — nie ma osobnej subdomeny „app.". Domena już
wskazuje na Cloudflare (sprawdzone przez DNS), więc od razu przechodzisz
do konfiguracji.

**Kolejność (rób dokładnie w tej kolejności, żeby zrobić tylko jeden
redeploy zamiast dwóch):**

1. **Napraw `NEXT_PUBLIC_APP_URL`** w zmiennych aplikacji (§3.2) na
   `https://faktflow.pl`, jeśli tam jeszcze nie jest.
2. W Coolify, w aplikacji: zakładka **Domains**. Dodaj **oba** adresy
   (Coolify pozwala na kilka domen dla jednej apki — osobne linie albo
   przecinek, zależnie od wersji UI):
   ```
   https://faktflow.pl
   https://www.faktflow.pl
   ```
3. Cloudflare → DNS → dodaj **dwa** rekordy, oba typu `A`, oba wskazujące
   na publiczne IP `app-1` (**`116.203.71.134`**), oba z chmurką
   **SZARĄ (DNS only)** — na czas wystawienia certyfikatu:
   | Typ | Nazwa | Wartość | Proxy |
   |---|---|---|---|
   | A | `@` (czyli goła domena) | `116.203.71.134` | Szara (DNS only) |
   | A | `www` | `116.203.71.134` | Szara (DNS only) |
4. Wróć do Coolify → **Deploy**. Ten jeden build załatwia dwie rzeczy
   naraz: wypieka poprawiony `NEXT_PUBLIC_APP_URL` w kod ORAZ rejestruje
   domenę w proxy Coolify, które samo wystąpi o certyfikat Let's Encrypt.
   Pierwszy build ~5-10 min.
5. Gdy `https://faktflow.pl` ładuje się na kłódce (bez ostrzeżenia
   certyfikatu) → wróć do Cloudflare i przełącz **OBIE** chmurki na
   **POMARAŃCZOWĄ (Proxied)**, a w Cloudflare → SSL/TLS ustaw tryb
   **Full (strict)**.

### 3.4 Rzeczy, które trzeba przepiąć ręcznie po zmianie hostingu

Dobra wiadomość: skoro używasz TEJ SAMEJ domeny co na Vercelu
(`faktflow.pl`), prawie nic nie trzeba przepinać — usługi zewnętrzne są
przypięte do domeny, nie do hostingu.

- **Inngest** (dashboard Inngest → Twoja app → ustawienia/sync URL):
  zerknij, czy widnieje tam `https://faktflow.pl/api/inngest`. Skoro
  domena się nie zmienia — **nie musisz nic klikać**, to tylko szybka
  weryfikacja, żeby mieć pewność (nie ślepa wiara).
- **Stripe webhook, Resend webhook, Turnstile, Google OAuth** — identycznie:
  działają bez zmian, bo są przypięte do domeny `faktflow.pl`, którą
  właśnie przenosisz razem z hostingiem, nie zamieniasz na inną.

✅ **Weryfikacja etapu:** logujesz się na `https://faktflow.pl`,
wystawiasz fakturę testową do KSeF (env test), pobierasz PDF, `/api/health`
zwraca `healthy`. Vercel możesz na razie zostawić — działa jako zapas.

---

## 4. ETAP 3 — baza danych i logowanie: Supabase self-hosted (~2-3 h)

Najważniejszy etap. Dlatego robimy go z pomostem bezpieczeństwa: stara baza
w chmurze zostaje nietknięta do samego końca (Etap 9).

### 4.1 Postaw Supabase w Coolify

1. **Projects → faktflow → Add Resource → Service → Supabase** → serwer: `db-1`.
2. Coolify wygeneruje CAŁY stack (Postgres, GoTrue-auth, PostgREST-api,
   Studio-panel, Kong-brama) i sekrety (`JWT_SECRET`, `ANON_KEY`,
   `SERVICE_ROLE_KEY`, hasło Postgresa). Zapisz je wszystkie w 1Password.
3. W konfiguracji serwisu ustaw domenę dla bramy (Kong):
   `https://db.faktflow.pl` → w Cloudflare dodaj rekord `A` → publiczne IP
   db-1 (szara chmurka na czas certyfikatu, potem jak w 3.3).
4. **Deploy**. Po chwili panel Studio dostępny (login/hasło z env serwisu).

### 4.2 Konfiguracja logowania (GoTrue) — env serwisu Supabase w Coolify

Dopisz/zmień w Environment Variables serwisu:

```
SITE_URL=https://faktflow.pl
API_EXTERNAL_URL=https://db.faktflow.pl
ADDITIONAL_REDIRECT_URLS=https://faktflow.pl/auth/callback
# E-maile (potwierdzenia, reset hasła) przez Resend:
SMTP_HOST=smtp.resend.com
SMTP_PORT=587
SMTP_USER=resend
SMTP_PASS=<Twój RESEND_API_KEY>
SMTP_ADMIN_EMAIL=no-reply@faktflow.pl
SMTP_SENDER_NAME=FaktFlow
# Google OAuth:
GOTRUE_EXTERNAL_GOOGLE_ENABLED=true
GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID=<z Google Console>
GOTRUE_EXTERNAL_GOOGLE_SECRET=<z Google Console>
GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI=https://db.faktflow.pl/auth/v1/callback
```

W Google Cloud Console (ten sam projekt OAuth co dziś) dodaj do
„Authorized redirect URIs": `https://db.faktflow.pl/auth/v1/callback`.

### 4.3 Schemat bazy = Twoje migracje ✅ WYKONANE (14 sierpnia 2026)

**Status: zrobione.** 59 migracji wgranych, 50 tabel utworzonych, RLS
włączony na wszystkich 50 (pełna izolacja klientów), funkcje
bezpieczeństwa `is_member_of` / `get_current_tenant_id` /
`shares_active_org_with` (fix rekurencji z 00058) na miejscu.

**Metoda — tunel SSH, NIE wystawianie bazy do internetu.** Pierwotnie ten
dokument radził tymczasowo opublikować port 5432 na świat. To zły pomysł:
port bazy w internecie (choćby na chwilę) to zaproszenie dla skanerów.
Zamiast tego port kontenera jest przekierowany przez zaszyfrowany tunel
SSH — nic nie jest wystawione publicznie ani na sekundę.

Gdybyś musiał powtórzyć (np. po odtworzeniu bazy z backupu):

```bash
cd /Users/mokryrys/dev/ksef-saas
PGPASS_RAW=$(ssh -i ~/.ssh/hetzner_faktflow_ed25519 root@178.104.128.144 \
  "docker exec supabase-db-ovrhjbsdpjdlnmkle1ulid4s printenv POSTGRES_PASSWORD")
PGPASS_ENC=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.stdin.read().strip(), safe=''))" <<< "$PGPASS_RAW")
ssh -i ~/.ssh/hetzner_faktflow_ed25519 -f -N -L 55432:172.19.0.5:5432 root@178.104.128.144
SUPABASE_DB_URL="postgresql://postgres:${PGPASS_ENC}@127.0.0.1:55432/postgres?sslmode=disable" pnpm db:push:prod
pkill -f "55432:172.19.0.5:5432"
```

Trzy rzeczy, o które łatwo się potknąć (wszystkie już uwzględnione wyżej):
- **`?sslmode=disable`** — CLI Supabase domyślnie żąda SSL, którego
  lokalny Postgres nie oferuje. Bezpieczne, bo ruch i tak idzie tunelem.
- **Hasło URL-encoded** — jeśli zawiera `@` czy `/`, bez kodowania
  connection string się rozjedzie.
- **IP kontenera** (`172.19.0.5`) może się zmienić po odtworzeniu serwisu.
  Sprawdź: `docker inspect supabase-db-… --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'`

### 4.4 Dane

Masz tylko dane testowe, więc **rekomendacja: zacznij na czysto** —
zarejestruj konta testowe od nowa (2 minuty), unikając żonglowania
tabelą `auth.users` między instancjami.

(Opcja B, gdyby jednak zależało Ci na danych: `supabase db dump --db-url
"<STARY_URL_Z_DASHBOARDU>" --data-only -f dane.sql` a potem
`psql "<NOWY_URL>" -f dane.sql`. Konta userów wymagają osobno
`pg_dump --schema=auth --data-only` — zrobimy razem, jeśli zajdzie potrzeba.)

### 4.5 Przepięcie apki na nową bazę

W Coolify, w APLIKACJI, podmień 3 zmienne i **Redeploy** (NEXT_PUBLIC_* to
Build Variables — redeploy przebuduje bundle):

```
NEXT_PUBLIC_SUPABASE_URL=https://db.faktflow.pl
NEXT_PUBLIC_SUPABASE_ANON_KEY=<ANON_KEY z Coolify>
SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY z Coolify>
```

✅ **Weryfikacja etapu:** rejestracja nowego konta (mail z potwierdzeniem
przychodzi przez Resend!), logowanie Google, onboarding z NIP, faktura
testowa, 2FA. Stara baza w Supabase Cloud: NIE ruszaj — czeka jako zapas.

---

## 5. ETAP 4 — Redis (cache i limity) (~30 min)

> **Stan faktyczny (23.10.2026):** Redis (redis:7.2) i SRH stoją na `app-1`,
> nie na `ops-1` jak w planie niżej. Zmienne `UPSTASH_REDIS_REST_*` ma
> aplikacja (Coolify id=1) **i** worker (id=2). Produkcja nie korzysta
> z chmury Upstash.

1. Coolify → **Add Resource → Database → Redis** (lub Valkey, jeśli jest na
   liście — to zamiennik 1:1) → serwer `ops-1`. Zapisz hasło.
2. Apka mówi do Redisa przez HTTP (styl Upstash), więc stawiamy malutki
   tłumacz **SRH**: **Add Resource → Service → Docker Compose** na `ops-1`:

```yaml
services:
  srh:
    image: hiett/serverless-redis-http:latest
    environment:
      SRH_MODE: env
      SRH_TOKEN: "WYMYSL_DLUGI_TOKEN_I_ZAPISZ"
      SRH_CONNECTION_STRING: "redis://default:HASLO_REDISA@NAZWA_HOSTA_REDISA:6379"
```

   (Nazwę hosta Redisa podpowie Coolify w zakładce serwisu Redis —
   kontenery w Coolify na tym samym serwerze widzą się po nazwach.)
3. W aplikacji podmień i Redeploy:

```
UPSTASH_REDIS_REST_URL=http://<adres-srh-z-coolify>
UPSTASH_REDIS_REST_TOKEN=<Twój SRH_TOKEN>
```

✅ **Weryfikacja:** `/api/health` → sekcja `informational.redis: ok`.
Rate-limit logowania działa (6 szybkich prób logowania = blokada).

---

## 6. ETAP 5 — pliki: MinIO zamiast R2 (~1 h)

1. Coolify → **Add Resource → Service → MinIO** → serwer `ops-1`. Ustaw
   domenę API np. `https://s3.faktflow.pl` (Cloudflare: rekord A → IP ops-1,
   procedura certyfikatu jak zwykle). Zapisz ACCESS/SECRET KEY.
2. W konsoli MinIO utwórz bucket o TEJ SAMEJ nazwie co w R2 (env
   `R2_BUCKET_NAME`).
3. Skopiuj istniejące pliki (z Maca; `brew install rclone`):

```bash
rclone config   # dodaj zdalne: "r2" (S3/Cloudflare R2) i "minio" (S3/MinIO)
rclone sync r2:NAZWA_BUCKETU minio:NAZWA_BUCKETU -P
```

4. W aplikacji podmień i Redeploy:

```
R2_ENDPOINT=https://s3.faktflow.pl
R2_ACCESS_KEY_ID=<z MinIO>
R2_SECRET_ACCESS_KEY=<z MinIO>
R2_FORCE_PATH_STYLE=true
```

   (`R2_ACCOUNT_ID` zostaw jakikolwiek niepusty — przy jawnym endpoincie
   nie jest używany. `R2_FORCE_PATH_STYLE` to przełącznik dodany w kodzie
   24 lipca — MinIO adresuje buckety inaczej niż R2.)

✅ **Weryfikacja:** wyślij fakturę testową → w konsoli MinIO pojawia się
XML; pobierz PDF (drugi raz — z cache). R2 zostawiamy na 30 dni jako zapas.

---

## 7. ETAP 6 — monitoring: Uptime Kuma (+ GlitchTip później) (~30 min)

1. **GlitchTip — ŚWIADOMIE ODKŁADAMY.** To ciężka usługa (własny Postgres +
   Redis + procesy Django, łącznie ~2 GB RAM), a `ops-1` ma 4 GB zajęte
   przez Coolify i MinIO (Redis stoi na `app-1`, sekcja 5). Na etapie testów **zostaw Sentry** (darmowy
   plan w zupełności wystarcza na 5-10 osób) — nic nie zmieniasz w kodzie.
   GlitchTipa wstawisz jednym kliknięciem PO powiększeniu `ops-1` (Rescale,
   §11, docelowo ~8 GB) — najlepiej gdy zbliżysz się do limitu darmowego Sentry
   albo tuż przed wpuszczeniem prawdziwych klientów. Wtedy: Coolify →
   **Add Resource → Service → GlitchTip** → domena `errors.faktflow.pl` →
   skopiuj **DSN** → podmień `NEXT_PUBLIC_SENTRY_DSN` (Build Variable!)
   → Redeploy. Kod jest identyczny — GlitchTip mówi protokołem Sentry.
2. **Uptime Kuma** (lekki, ~150 MB — stawiamy od razu): Coolify → **Add
   Resource → Service → Uptime Kuma** →
   `ops-1`, domena `https://status-int.faktflow.pl`. Dodaj monitory (typ
   HTTP, co 60 s):
   - `https://faktflow.pl/api/health` (słowo kluczowe: `healthy`)
   - `https://db.faktflow.pl/auth/v1/health`
   - `https://s3.faktflow.pl/minio/health/live`
   W każdym monitorze → Notifications → podepnij webhook Slacka (#urgent).

✅ **Weryfikacja:** zatrzymaj na chwilę aplikację w Coolify (Stop) — w ciągu
minuty Uptime Kuma robi się czerwona i Slack dostaje alert. Włącz z powrotem
(Start) → zielono. Błędy aplikacji nadal widzisz w Sentry (`/sentry-example-page`
rzuca testowy wyjątek).

---

## 8. ETAP 7 — joby w tle: Inngest → pg-boss (kod, robi AI — Twoja rola: review + klik)

To jedyny etap, gdzie trzeba PISAĆ kod (36 jobów, ~61 plików dotkniętych).
Piszę go ja, w osobnych sesjach, paczkami — Ty robisz review i deploy.

Plan techniczny (dla przejrzystości):

1. **Fundament**: `lib/jobs/` — kolejka pg-boss (tabele w TWOIM Postgresie,
   zero nowej infry), entrypoint `worker.ts`, harmonogramy cron, helper
   `enqueue()` z tym samym interfejsem co dzisiejsze `inngest.send()`.
2. **Porty paczkami** (od najprostszych): crony/utrzymanie → maile →
   OCR/eksporty/import → **submit-invoice + UPO na końcu** (najbardziej
   krytyczne: retry 30s→1h, throttle 60/min per tenant, Offline24 —
   wszystko odtwarzamy 1:1, z testami).
3. **Deploy**: w Coolify druga aplikacja z TEGO SAMEGO repo/obrazu,
   z komendą startu `node worker.js`, na `app-1`. Feature flag
   `JOBS_BACKEND=pgboss|inngest` pozwala przełączać się bez strachu.
4. **Tydzień równoległości**: nowe joby na pg-boss, Inngest jeszcze
   podpięty. Po tygodniu czystych logów — odpinamy Inngest.

✅ **Weryfikacja:** faktura testowa przechodzi cały cykl (wysyłka → numer
KSeF → UPO → mail) bez Inngest w łańcuchu.

---

## 9. ETAP 8 — backupy na poważnie (~1 h)

Trzy niezależne warstwy (są już częściowo w kodzie!):

1. **Hetzner Backups na db-1** — już włączone w Etapie 0 (7 snapshotów, automat).
2. **Aplikacyjny snapshot dzienny** — istniejący job `daily-db-snapshot`
   (po Etapie 7 działa na pg-boss) zrzuca bazę do MinIO. Sprawdź w admin
   panelu `/admin/system` → BackupStatusCard, że po migracji nadal chodzi.
3. **Kopia POZA serwerami — Storage Box**: na `ops-1` zainstaluj rclone
   i wgraj harmonogram kopiowania bucketa backupów na Storage Box:

```bash
apt install -y rclone
rclone config   # zdalne "minio" (jak w 6.3) i "box" (typ SFTP: host
                # uXXXXX.your-storagebox.de, user uXXXXX, port 23)
crontab -e      # wybierz nano (1); dopisz na końcu linijkę:
```

```
30 3 * * * rclone sync minio:NAZWA_BUCKETU/backups box:faktflow-backups >> /var/log/rclone-backup.log 2>&1
```

   (Czyli: codziennie 3:30 w nocy kopiuj backupy na Storage Box. Zapis:
   minuta, godzina, dzień-miesiąca, miesiąc, dzień-tygodnia.)

4. **PRÓBA GENERALNA ODTWORZENIA** (obowiązkowa, raz na miesiąc): ściągnij
   wczorajszy zrzut ze Storage Box i wgraj do lokalnego/testowego Postgresa.
   Backup, którego nie testowałeś, to nie backup — to nadzieja.

---

## 10. ETAP 9 — sprzątanie (dopiero po 2 TYGODNIACH stabilności!)

Checklist wyłączeń (kolejność dowolna, wszystkie odwracalne przez ~30 dni):

- [ ] Vercel: projekt → Pause/Delete (najpierw Pause).
- [ ] Supabase Cloud: projekt → Pause (tydzień) → Delete.
- [ ] Upstash: usuń bazę Redis.
- [ ] Inngest: odepnij apkę (po Etapie 7 + tydzień równoległości).
- [ ] Sentry: **NIE zamykaj** — działa dalej na darmowym planie do czasu,
      aż postawisz GlitchTipa (§7 pkt 1). Wtedy zamknij projekt.
- [ ] R2: po 30 dniach od Etapu 5 usuń bucket (najpierw upewnij się, że
      kopia plików jest w MinIO — `rclone check`).
- [x] Vercel Edge Config: ZROBIONE (Etap 7.8) — tabela `global_feature_flags`
      + migracja 00060; pakiet `@vercel/edge-config` usunięty z zależności.

---

## 11. KOSZTY I ŚCIEŻKA WZROSTU (bez ponownej przeprowadzki!)

### Teraz (testy, 5-10 osób): ~67,73 €/mc z VAT ≈ 290 zł (docelowo ~34 €, gdy CX33 wróci do magazynu)

Pełne wyliczenie w §1.6. W skrócie: CX23 (app) + CX23 (ops) + CPX32 (db,
zastępczo za wyprzedane CX33) + 3× IPv4 + Backups.

⚠️ **Ważne zastrzeżenie do CAŁEJ tej sekcji:** dostępność konkretnych typów
serwerów w Hetznerze zmienia się z tygodnia na tydzień (widziałeś to na
własne oczy: Falkenstein bez CX, Helsinki bez CX, Nuremberg z CX23 ale bez
CX33). Poniższa tabela pokazuje **docelowe specyfikacje** (ile RAM/CPU
faktycznie potrzebujesz na danym etapie) — nie traktuj konkretnych nazw
typów i cen jako gwarancji. **Przy KAŻDYM Rescale sprawdź w konsoli, co
jest akurat dostępne**, i wybierz najtańszy typ spełniający wymaganie RAM
z kolumny „Potrzebujesz". Jeśli najtańsza linia (CX) akurat nie ma stocku,
weź najbliższy CPX o tej samej lub większej pamięci — dopłacisz, ale
niczego nie tracisz, a przy kolejnym Rescale (w dowolną stronę, także w
dół) możesz wrócić na tańszą linię, gdy wróci do sprzedaży.

### Jak rosnąć: funkcja „Rescale" (TAK — bez przenoszenia czegokolwiek)

Hetzner pozwala powiększyć istniejący serwer w miejscu:
serwer → wyłącz (Power Off) → **Rescale** → wybierz większy typ → włącz.
~2-5 min przerwy, ten sam serwer, to samo IP, te same dane, po prostu
mocniejszy. Nic nie instalujesz od nowa.

**Dwie WAŻNE zasady:**

1. Przy rescale wybieraj opcję **„CPU i RAM only"** (bez powiększania dysku).
   Powiększenie dysku jest NIEODWRACALNE i zamyka drogę powrotu na mniejszy
   plan. Gdy zabraknie miejsca — dokup **Volume** (elastyczny dysk,
   ~0,06 €/GB/mc z VAT, powiększalny w locie, przenośny między serwerami).
2. **Architektura musi zostać ta sama** (x86 → x86). Dlatego w §1.3
   wybieramy x86, nie ARM — inaczej „upgrade" oznaczałby budowę serwera
   od zera.

### Plan wzrostu — docelowe specyfikacje (ceny z VAT, „jeśli CX dostępne" / „jeśli tylko CPX")

| Skala | app-1 potrzebuje | db-1 potrzebuje | ops-1 potrzebuje | Razem: CX / tylko-CPX |
|---|---|---|---|---|
| **5-10 (teraz)** | 2 vCPU/4 GB | 4 vCPU/8 GB | 2 vCPU/4 GB | ~28 € / **~68 €** (dziś: to drugie) |
| ~500 klientów | 4 vCPU/8 GB | 8 vCPU/16 GB | 4 vCPU/8 GB | ~45 € / ~130 € |
| ~2 000 | 8 vCPU/16 GB | 8 vCPU/16 GB | 4 vCPU/8 GB | ~55 € / ~170 € |
| ~10 000 | 2× (16 vCPU/32 GB) + LB | 16 vCPU/32 GB + Backups | 8 vCPU/16 GB | ~140-150 € / znacznie więcej |

Kolumna „tylko-CPX" to cena, GDYBY w danym momencie żadna tańsza linia CX
nie była dostępna (obecna sytuacja) — realny koszt najpewniej wyląduje
gdzieś pomiędzy, bo część typów CX zwykle jest w magazynie. Traktuj
kolumnę CX jako cel, do którego wracasz Rescale'em w dół przy każdej
okazji, a kolumnę CPX jako budżet awaryjny, którego się nie boisz.

Kiedy dokładnie klikać Rescale — progi metryk (CPU > 70%, pamięć, czas
zapytań) masz w [scaling-triggers.md](../runbooks/scaling-triggers.md).
Praktyczna zasada: patrz na wykresy w konsoli Hetznera raz w tygodniu;
gdy średnie CPU przekracza 60-70% przez kilka dni — powiększ.

Alternatywa na sam koniec skali: seria **CCX** (dedykowane vCPU — nikt nie
„podkrada" mocy). Sprawdzisz ceny i dostępność w konsoli w momencie, gdy
będzie potrzebna. Przejście CX/CPX → CCX to również zwykły Rescale.

Przy 10 000 klientów jedyna NOWA rzecz to drugi serwer aplikacji + **Load
Balancer** (Hetzner → Load Balancers → LB11; dodajesz oba serwery app jako
cele, DNS wskazuje na balancer). Aplikacja jest bezstanowa (sesje w cookies,
pliki w MinIO, kolejka w Postgresie) — więc drugi serwer to klik w Coolify
(„dodaj destination"), nie projekt przeprowadzki. Ewentualny self-host
PostHog (analityka) to wtedy osobny serwer (docelowo 8 vCPU/16 GB) — do
decyzji, bo darmowy plan PostHog Cloud EU wystarcza bardzo długo.

Dla porównania: obecny stack SaaS przy 10k klientów kosztowałby
kilkaset € miesięcznie (Vercel Pro + usage, Supabase Pro + compute, Inngest,
Upstash, Sentry, PostHog — ostrożnie 700-1000 €/mc). Hetzner: ~150-170 €
nawet w wariancie „tylko-CPX".

---

## 12. KOLEJNOŚĆ PRAC — Twoja checklista tempa

| Dzień | Co | Kto |
|---|---|---|
| 1 | Etap 0 (zakupy) + Etap 1 (Coolify) | Ty (instrukcja wyżej) |
| 2 | Etap 2 (apka na Hetzner) | Ty klikasz, AI debuguje z Tobą |
| 3-4 | Etap 3 (Supabase self-hosted) | Ty klikasz, AI debuguje |
| 4 | Etap 4 (Redis) + Etap 5 (MinIO) | Ty |
| 5 | Etap 6 (Uptime Kuma) + Etap 8 (backupy) | Ty |
| 6-12 | Etap 7 (pg-boss — kod) | AI pisze, Ty review + deploy |
| +14 dni stabilności | Etap 9 (sprzątanie) | Ty |

Realnie: **~2 tygodnie do pełnego przeniesienia**, z czego Twojego klikania
jest ~2-3 dni.
