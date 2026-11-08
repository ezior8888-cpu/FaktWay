# Procedura: nowy dostawca, który widzi dane osobowe

Dotyczy każdej usługi zewnętrznej, do której mogą trafić dane osobowe —
także „przy okazji” (logi, raporty błędów, załączniki maili, alerty).
Przykłady z przeszłości: Slack dostawał e-mail użytkownika przy eskalacji
czatu, a nie było go na liście; poczta przychodząca idzie przez Cloudflare.

## Zanim podepniesz dostawcę

1. **Umowa powierzenia (DPA)** — zaakceptuj u dostawcy; zapisz mechanizm
   przekazania poza EOG (DPF albo SCC) i region danych.
2. **Minimalizacja** — wysyłaj tylko to, co potrzebne; oczyszczaj dane
   (wzór: `lib/observability/scrub.ts`, `lib/analytics/privacy.ts`).
3. **Wpis w `lib/legal/subprocessors.ts`** w tym samym PR: nazwa, siedziba,
   cel, lokalizacja danych, transfer, role (`client_data` — gdy widzi dane
   z faktur klientów; `own_data` — tylko nasze). Test
   `tests/unit/legal-dokumenty.test.tsx` sprawdzi, że polityka i umowa
   powierzenia go pokazują.
4. **Rejestr czynności** (`docs/prawne/rejestr-czynnosci-przetwarzania.md`) —
   dopisz dostawcę w kolumnie odbiorców.

## Gdy dostawca ma rolę `client_data` — uprzedzenie klientów

Umowa powierzenia § 6 ust. 3: **co najmniej 14 dni przed** zmianą e-mail
do właścicieli wszystkich organizacji. Klient może zgłosić sprzeciw; jeśli
się nie dogadamy, może wypowiedzieć umowę ze zwrotem niewykorzystanej
opłaty. Wyjątek: nagła zmiana z powodów bezpieczeństwa — informacja
niezwłocznie, z uzasadnieniem (§ 6 ust. 4).

Szablon:

> Temat: Zmiana dostawcy przetwarzającego dane w FaktWay — od [data]
>
> Dzień dobry, zgodnie z umową powierzenia (§ 6) informujemy, że od [data,
> min. 14 dni] będziemy korzystać z [dostawca, siedziba] w zakresie [cel].
> Dane będą przetwarzane w [lokalizacja]; przekazanie poza EOG zabezpiecza
> [mechanizm]. Aktualna lista: https://faktway.pl/legal/podprocesorzy.
> Jeśli mają Państwo zastrzeżenia, prosimy o odpowiedź do [data].

Wysyłka do wszystkich właścicieli — transakcyjnie (nie wymaga zgody
marketingowej), z wpisem w dzienniku zdarzeń.

## Gdy zmieniasz tylko dostawcę danych własnych (`own_data`)

Uprzedzenie klientów nie jest wymagane — wystarczy aktualizacja listy,
polityki prywatności (generuje się z listy) i rejestru czynności.
