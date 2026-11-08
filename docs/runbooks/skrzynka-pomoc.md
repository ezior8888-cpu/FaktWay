# Skrzynka pomoc@faktflow.pl

> **RODO (15.10.2026):** na `pomoc@` trafiają żądania RODO, reklamacje,
> odstąpienia od umowy i dokumenty klientów. Skrzynka docelowa musi mieć
> umowę powierzenia — prywatny Gmail jej nie ma. Użyj skrzynki firmowej
> z DPA (np. Google Workspace) i wpisz dostawcę do `lib/legal/subprocessors.ts`.
> Terminy odpowiedzi: `docs/prawne/procedura-zadan-i-reklamacji.md`.

Krok 10 planu automatyzacji (1 października 2026), MAN-18 i MAN-19. Kod
workera: `ops/poczta/worker.mjs`.

## Stan na 1 października 2026

| Sprawa | Stan |
|---|---|
| Poczta przychodząca na `@faktflow.pl` | **nie działa** — domena nie ma rekordów MX; maile na `pomoc@`, `kontakt@`, `dmarc@` giną |
| Stara domena `ksef-saas.pl` | **niezarejestrowana** (NASK). Kod już jej nie używa — wszystkie adresy to teraz `pomoc@faktflow.pl` (`lib/site.ts`) |
| Odpowiedzi na maile z aplikacji | maile mają teraz nagłówek „Odpowiedz do: pomoc@faktflow.pl” |

## Co da konfiguracja niżej

- Każdy mail na **dowolny** adres w `faktflow.pl` trafi do Twojej zwykłej
  skrzynki (np. Gmail) i do skrzynki Igora.
- W Telegramie przyjdzie powiadomienie: na jaki adres, kategoria (RODO,
  płatność/zwrot, KSeF, logowanie, błąd, sprzedaż, inne) i czy to pilne.
- W powiadomieniu **nie ma** nadawcy, tematu ani treści. Do czasu opinii
  prawnej treść zgłoszeń nie wychodzi do żadnego API ani do Telegrama.
  Kategorię worker liczy sam, ze słów w temacie.

## Konfiguracja w Cloudflare (~20 minut)

Domena `faktflow.pl` jest w Cloudflare, więc wszystko robisz na
dash.cloudflare.com → domena **faktflow.pl**.

1. **Włącz przekazywanie poczty.** Menu **Email** → **Email Routing** →
   *Get started* (albo *Enable*). Cloudflare zaproponuje dodanie rekordów
   MX i SPF → *Add records and enable*. Od tej chwili domena przyjmuje pocztę.

   **SPF — tylko jeden rekord.** Domena ma już
   `v=spf1 include:_spf.resend.com ~all` (wysyłka maili z aplikacji).
   Dwa rekordy SPF psują dostarczanie. W **DNS** → **Records** zostaw jeden
   rekord TXT dla `faktflow.pl`:
   `v=spf1 include:_spf.mx.cloudflare.net include:_spf.resend.com ~all`.
2. **Skrzynki docelowe.** Email Routing → **Destination addresses** → *Add*
   → Twój adres (np. Gmail). Cloudflare wyśle mail z linkiem — kliknij go.
   Igor robi to samo ze swoim adresem. Bez potwierdzenia worker nie może tam
   nic przekazać.
3. **Worker.** Email Routing → **Email Workers** → *Create* → nazwa
   `faktflow-poczta` → otwórz edytor kodu → usuń przykład → wklej **całą**
   zawartość `ops/poczta/worker.mjs` → *Deploy*.
4. **Zmienne workera.** Workers & Pages → `faktflow-poczta` → **Settings** →
   **Variables and Secrets** → *Add*:

   | Nazwa | Typ | Wartość |
   |---|---|---|
   | `FORWARD_TO` | Text | potwierdzone adresy z kroku 2, po przecinku |
   | `TELEGRAM_CHAT_IDS` | Text | Twoje Id z @userinfobot (i Igora), po przecinku |
   | `TELEGRAM_BOT_TOKEN` | **Secret** | token bota (ten sam co w bramce) |

   *Deploy*.
5. **Reguły.** Email Routing → **Routing rules**:
   - *Custom address*: `pomoc@faktflow.pl` → akcja *Send to a Worker* →
     `faktflow-poczta`;
   - *Catch-all address*: włącz → *Send to a Worker* → `faktflow-poczta`
     (dzięki temu nie zginą maile na `kontakt@`, `powiadomienia@` itd.).
6. **Test.** Z prywatnej skrzynki wyślij mail na `pomoc@faktflow.pl`
   z tematem „Test KSeF”. W ciągu minuty: mail w Twojej skrzynce
   i w Telegramie „🔴 Nowa wiadomość na pomoc@faktflow.pl · KSeF / faktury
   · pilne”. Raporty DMARC (na `dmarc@`) i odbicia trafiają do skrzynki bez
   powiadomienia.

## Odpowiadanie jako pomoc@faktflow.pl (opcjonalnie, Gmail)

Cloudflare tylko przekazuje pocztę — odpowiadasz ze swojego adresu. Żeby
klient widział w odpowiedzi `pomoc@faktflow.pl`:

1. **Resend** → *API Keys* → *Create API Key* → nazwa `gmail-pomoc`,
   uprawnienie **Sending access**, domena `faktflow.pl`. Skopiuj klucz.
2. **Gmail** → Ustawienia → *Konta i import* → *Wyślij pocztę jako* →
   *Dodaj inny adres e-mail* → nazwa „FaktFlow – pomoc”, adres
   `pomoc@faktflow.pl` → *Dalej* → serwer SMTP `smtp.resend.com`, port `465`,
   użytkownik `resend`, hasło = klucz z punktu 1, połączenie SSL →
   *Dodaj konto*. Gmail wyśle kod na `pomoc@faktflow.pl` — przyjdzie do Ciebie
   przez routing z kroków wyżej; wpisz go.
3. Odpowiadając klientowi, wybierz w polu „Od” `pomoc@faktflow.pl`.

## Stara domena ksef-saas.pl — do decyzji

Nikt jej nie ma (NASK, 1.10.2026). Klienci, którzy zapisali stare adresy,
mogą jeszcze na nie pisać — a osoba, która domenę kupi, zacznie te maile
odbierać. Opcja: zarejestrować ją obronnie na rok, dodać do Cloudflare,
ustawić catch-all na ten sam worker i przekierowanie strony na
`https://faktflow.pl`. Koszt [DO WERYFIKACJI] u rejestratora.

## Ograniczenia i dalej

- Kategoria tylko z tematu, prosty słownik. „Inne” = trzeba przeczytać.
- Pełna recepcja B-3 (szkic odpowiedzi, przyciski w Telegramie) dopiero po
  opinii prawnej o przetwarzaniu treści zgłoszeń (`06_PLAN_B` § 3, § 7).
