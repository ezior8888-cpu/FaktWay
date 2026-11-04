# Procedura: żądania RODO, reklamacje, odstąpienia, zgłoszenia treści

Wszystko trafia na `pomoc@faktway.pl` (skrzynka: `docs/runbooks/skrzynka-pomoc.md`;
worker oznacza kategorię „RODO” w temacie). Każdą sprawę wpisz do
rejestru żądań POZA repozytorium: data wpływu, rodzaj, termin, kto
prowadzi, data i sposób odpowiedzi.

## Terminy

| Sprawa | Termin odpowiedzi | Skutek przekroczenia | Podstawa |
|---|---|---|---|
| Żądanie RODO (dostęp, sprostowanie, usunięcie, ograniczenie, przeniesienie, sprzeciw) | **1 miesiąc** od wpływu; przedłużenie o 2 miesiące tylko przy złożonych sprawach — z informacją w ciągu pierwszego miesiąca | skarga do UODO, kara | art. 12 ust. 3 RODO |
| Reklamacja usługi | **14 dni** | uznanie reklamacji (dla konsumenta i PNPK — regulamin) | regulamin § 12 ust. 3; art. 7a UPK |
| Odstąpienie od umowy (konsument, PNPK) | potwierdzenie **niezwłocznie**; zwrot płatności **14 dni** | odsetki, roszczenia | regulamin § 13; art. 31–32 UPK |
| Zgłoszenie treści bezprawnej | potwierdzenie odbioru; decyzja bez zbędnej zwłoki | odpowiedzialność za treść hostowaną | regulamin § 8 ust. 3; DSA art. 16 |
| Wypowiedzenie umowy przez klienta | potwierdzenie; eksport 30 dni; usunięcie w kolejnych 30 dniach | naruszenie umowy powierzenia § 9 | regulamin § 14; umowa powierzenia § 9 |
| Sprzeciw wobec zmiany podprocesora | odpowiedź przed wprowadzeniem zmiany | prawo wypowiedzenia klienta | umowa powierzenia § 6 ust. 3 |

## Żądania RODO

1. **Czyje dane?** Konto, rozliczenia, kontakt → **my jesteśmy administratorem**,
   realizujemy. Dane z faktur klienta (np. kontrahent pisze „usuńcie moje
   dane z faktury X”) → **administratorem jest klient**: w ciągu 5 dni
   roboczych przekaż żądanie klientowi (właścicielowi organizacji) i
   odpisz wnioskodawcy, że przekazaliśmy je administratorowi — nie
   usuwaj sam (umowa powierzenia § 7 ust. 1).
2. **Tożsamość.** Żądanie z adresu konta — zwykle wystarczy. Wątpliwości →
   poproś o potwierdzenie z adresu konta albo zalogowanie się. Nie żądaj
   więcej danych, niż potrzeba (art. 12 ust. 6 RODO).
3. **Realizacja:**
   - dostęp / przeniesienie — użytkownik pobiera sam: Ustawienia → Konto i
     firma → „Pobierz dane (JSON)”; dane firmy — eksport w panelu;
   - usunięcie konta — użytkownik sam (14 dni na wycofanie) albo operator;
     dane z obowiązkiem przechowywania (faktury za subskrypcję) zostają —
     napisz o tym w odpowiedzi;
   - sprzeciw wobec statystyk serwerowych — wyłączyć zdarzenia PostHog dla
     tego identyfikatora (osoba zgłaszająca + operator) i potwierdzić;
   - wycofanie zgody na e-maile — użytkownik w Ustawienia → Powiadomienia
     albo link w mailu; ręcznie: `setEmailConsent` (lib/legal/record.ts).
4. **Odpowiedź** — e-mailem, prostym językiem, z informacją o prawie skargi
   do Prezesa UODO, jeśli odmawiamy.

## Reklamacje

Odpowiedz w 14 dni: czy uznajemy, co zrobimy (naprawa, obniżenie ceny,
zwrot — `docs/runbooks/refund-and-disputes.md`), a przy odmowie —
uzasadnienie. Dla konsumenta i PNPK: brak odpowiedzi w terminie =
reklamacja uznana.

## Odstąpienie od umowy

Potwierdź odbiór od razu. Gdy było w okresie próbnym — brak opłat, anuluj
subskrypcję w Stripe. Gdy po płatności — zwrot w 14 dni tą samą metodą,
pomniejszony proporcjonalnie, jeśli klient zażądał rozpoczęcia usługi
(oświadczenie przy zakupie: wpis `legal.checkout_statement_accepted`
w dzienniku zdarzeń).

## Zgłoszenia treści bezprawnych (DSA)

1. Potwierdź odbiór.
2. Oceń: czy treść jest w naszym serwisie (np. wiadomość wysłana przez
   klienta do kontrahenta), czy zgłoszenie zawiera elementy z regulaminu
   § 8 ust. 3.
3. Decyzja proporcjonalna (regulamin § 8 ust. 4). Każde ograniczenie →
   uzasadnienie do użytkownika (zakres, podstawa faktyczna i prawna,
   możliwość reklamacji) — DSA art. 17.
4. Poinformuj zgłaszającego o decyzji i drodze odwoławczej.
5. Podejrzenie przestępstwa zagrażającego życiu lub bezpieczeństwu →
   niezwłocznie organy ścigania (DSA art. 18).
