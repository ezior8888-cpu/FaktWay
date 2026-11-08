# Procedura: naruszenie ochrony danych osobowych

Naruszenie to każde zdarzenie, przez które dane osobowe zostały
przypadkowo lub bezprawnie **zniszczone, utracone, zmienione, ujawnione**
albo ktoś uzyskał do nich nieuprawniony dostęp (art. 4 pkt 12 RODO).
Przykłady: wyciek bazy, dostęp jednej firmy do danych innej (awaria RLS),
faktura wysłana mailem do złego nabywcy przez błąd serwisu, utrata
kopii zapasowej, przejęte konto operatora, zgubiony laptop z dostępem.

## Terminy — liczone od chwili STWIERDZENIA naruszenia

| Kto | Komu | Termin | Podstawa |
|---|---|---|---|
| my jako podmiot przetwarzający (dane z faktur klientów) | każdemu klientowi, którego dane dotyczy — e-mail do właściciela organizacji | **36 godzin** | umowa powierzenia § 8 |
| my jako administrator (konta, rozliczenia, kontakt) | Prezes UODO — formularz na uodo.gov.pl | **72 godziny**, chyba że naruszenie raczej nie powoduje ryzyka | art. 33 RODO |
| my jako administrator, gdy ryzyko jest **wysokie** | osoby, których dane dotyczą | bez zbędnej zwłoki | art. 34 RODO |

Klient sam zawiadamia UODO i swoich kontrahentów o naruszeniu ich danych —
my dajemy mu informacje (umowa powierzenia § 7 ust. 2, § 8).

## Kroki

1. **Zatrzymaj wyciek** (godzina 0–4). Odetnij dostęp: wyłącz funkcję
   (bramka `/wylacz`), unieważnij klucze (`docs/runbooks/key-rotation.md`),
   zablokuj konto, przerwa techniczna. Zabezpiecz logi — nie kasuj niczego.
2. **Ustal fakty** (do 12 h): co się stało, od kiedy, które firmy i ile
   osób, jakie kategorie danych (czy są dane szczególne, numery rachunków,
   PESEL), czy dane są zaszyfrowane, czy skutek jest odwracalny.
3. **Oceń ryzyko** dla osób: niskie / ryzyko / wysokie. Pomocnicze pytania:
   czy możliwa kradzież tożsamości, oszustwo finansowe, ujawnienie
   tajemnicy przedsiębiorstwa klienta, dane o zdrowiu w opisach faktur?
4. **Zawiadom klientów** (do 36 h) — szablon niżej. Jeśli brakuje
   informacji, wyślij to, co wiesz, i uzupełniaj (art. 33 ust. 4).
5. **Zawiadom UODO** (do 72 h), jeśli jest ryzyko. Treść: art. 33 ust. 3 RODO.
6. **Zawiadom osoby** przy wysokim ryzyku — prostym językiem: co się
   stało, skutki, co zrobiliśmy, co mogą zrobić, kontakt.
7. **Wpisz do rejestru naruszeń** (art. 33 ust. 5) — także te, których nie
   zgłaszamy do UODO, z uzasadnieniem. Rejestr prowadź POZA repozytorium.
8. **Wnioski**: przyczyna, naprawa, test, który by to wykrył (protokół
   naprawy błędu z AGENTS.md).

## Szablon — zawiadomienie klienta (umowa powierzenia § 8)

> Temat: Naruszenie ochrony danych w FaktWay — [data]
>
> Dzień dobry, informujemy o naruszeniu ochrony danych osobowych, które
> powierzyli nam Państwo jako administrator.
> **Co się stało:** […]. **Kiedy:** od […] do […], stwierdzone [data, godzina].
> **Jakie dane i ile:** […] (kategorie osób, przybliżona liczba osób i wpisów).
> **Możliwe skutki:** […].
> **Co zrobiliśmy:** […]. **Co proponujemy:** […].
> Jako administrator decydują Państwo o zawiadomieniu Prezesa UODO
> (72 godziny od Państwa wiedzy o naruszeniu) i osób, których dane dotyczą.
> Kontakt w tej sprawie: […].
