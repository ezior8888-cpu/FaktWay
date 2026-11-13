import { defineConfig } from 'vitest/config';
import localConfig from './vitest.config';

/** Jawne uruchomienie na osobnej bazie testowej; testy tworzą i usuwają dane. */
export default defineConfig({
  ...localConfig,
  test: {
    ...localConfig.test,
    include: [
      'tests/rls-isolation.test.ts',
      'tests/rls-uprawnienia.test.ts',
      'tests/rls-cykl-faktury.test.ts',
      'tests/rls-kolejkowanie-wysylki.test.ts',
      'tests/rls-cykl-wyzwalacze.test.ts',
      'tests/rls-kontrola-offline24.test.ts',
      'tests/rls-korekta-jedna-otwarta.test.ts',
      'tests/rls-dane-specjalne.test.ts',
      'tests/rls-decyzja-duplikatu.test.ts',
      'tests/rls-zapis-oryginalu.test.ts',
      'tests/rls-oryginal-data-nadania.test.ts',
      'tests/rls-dziennik-prob-wysylki.test.ts',
      'tests/rls-kontrola-dziennik-prob.test.ts',
      'tests/rls-zwolnij-utknieta-wysylke.test.ts',
      'tests/rls-faktura-abonamentu-faktway.test.ts',
      'tests/rls-dzieci-faktur.test.ts',
      'tests/rls-lista-faktur-platnosc.test.ts',
      'tests/rls-data-rozpoczecia.test.ts',
      'tests/rls-faktury-cykliczne.test.ts',
      // 00155 (synchronizacja historii KSeF, decyzja Bartosza 22.10.2026): izolacja,
      // CHECK-i, ksef_upo_expected i filtr osadzenia przez PostgREST.
      'tests/rls-historia-ksef.test.ts',
      // 00157 (plan skalowania, sesja 20): sprzątanie dzienników paczkami.
      'tests/rls-sprzatanie-dziennikow.test.ts',
      // Bez migracji (plan skalowania, sesja 3, FLO-01): sprzątanie pulsu FLO jednym zapisem
      // z warunkiem; ponad 1000 kart przez PostgREST z `max_rows`, licznik i RETURNING bez ucięcia.
      'tests/rls-flo-sprzatanie.test.ts',
      // 00158 („Zapłacone” jednym dotknięciem, FaktWay 1.0 §3 pkt 3): RPC razem
      // z wyzwalaczami paid_amount, paid_at i payment_status, role, obca firma, przypomnienia.
      'tests/rls-zaplacone.test.ts',
      // 00159 (logowanie biometrią): RLS i granty kolumnowe `user_passkeys`, wyzwania
      // jednorazowe przez DELETE ... RETURNING, usuwanie zależne od AAL, kaskada z auth.users.
      'tests/rls-passkeys.test.ts',
      // 00160 (harmonogram Skrzynki KSeF): RPC wyboru należnych firm, uprawnienia,
      // rozsyłka w transakcji z pg-boss, przyspieszenie terminu, alarm względem poziomu.
      'tests/rls-skrzynka-harmonogram.test.ts',
      // 00161 (pomiar FaktWay 1.0): zgoda i źródło w `users`, data pierwszej
      // faktury w `tenants`, lejek `admin_funnel_weekly`, uzupełnienie z migracji.
      'tests/rls-lejek-analityka.test.ts',
      // 00163 (krok kodu przy dostępie osób trzecich): adres wysyłki i link dla księgowej,
      // przyjęcie prośby i zmiana roli odmawiają sesji AAL1 konta z 2FA; cofnięcie działa.
      'tests/rls-krok-kodu.test.ts',
      // 00164 (C-12): jeden wiersz `xml_documents` na fakturę, wyścig równoległych
      // zapisów i dowód bez nadpisania przez prawdziwy PostgREST.
      'tests/rls-xml-dowod-jeden-wiersz.test.ts',
      // 00165 (plan księgowości JDG, K1): wyłącznik modułu — flaga firmy domyślnie
      // false, czytelna tylko dla swojej firmy, bez zapisu kluczem użytkownika.
      'tests/rls-ksiegowosc-wylacznik.test.ts',
      // 00166 (plan księgowości JDG, K2): profil podatkowy — zapis owner/admin, izolacja firm,
      // forma tylko od 1 stycznia (wyzwalacz), CHECK-i stawki i daty ZUS, bez DELETE.
      'tests/rls-ksiegowosc-profil.test.ts',
      // 00167 (plan księgowości JDG, K3): wpisy ręczne ewidencji: zapis i usunięcie owner/admin,
      // izolacja firm, data wpisu i autor z bazy (granty kolumnowe), CHECK-i K_9 i kwoty, bez UPDATE.
      'tests/rls-ksiegowosc-wpisy.test.ts',
      // 00168 (plan księgowości JDG, K4): rozliczenia miesiąca: zatwierdzenie i zapłata owner/admin,
      // izolacja firm, granty kolumnowe, niezmienność kwoty (wyzwalacz), UNIQUE wersji, najem tylko przy ryczałcie.
      'tests/rls-ksiegowosc-rozliczenia.test.ts',
      // 00169 (plan księgowości JDG, K5): powiadomienia tylko dla zadań (service_role), UNIQUE jako
      // idempotencja cronów, przejęcie wpisu „failed”, CHECK-i, zgoda push „Księgowość”.
      'tests/rls-ksiegowosc-powiadomienia.test.ts',
      // 00170 (plan księgowości JDG, K6): wysyłki JPK do MF owner/admin, izolacja firm, jedna wysyłka
      // w toku na miesiąc, przejścia stanów i niezmienność pliku (wyzwalacz), granty kolumnowe, CHECK-i.
      'tests/rls-ksiegowosc-jpk.test.ts',
      // 00171 (plan księgowości JDG, K7): wpisy ręczne KPiR z kolumną; stawka albo kolumna (CHECK),
      // rozdział czytników ewidencji i KPiR, role i izolacja jak w 00167.
      'tests/rls-ksiegowosc-kpir.test.ts',
      // 00173 (plan księgowości JDG, K7.4): spis z natury; jeden na dzień, data od 31.12.2025, bez UPDATE,
      // role i izolacja jak w 00167.
      'tests/rls-ksiegowosc-spis.test.ts',
      // 00174 (krok 8.5 planu kompletnej aplikacji): zalogowane urządzenia i historia logowań;
      // tylko własne sesje, anon bez dostępu, krok kodu przy 2FA, wylogowanie widziane przez GoTrue.
      'tests/rls-sesje-konta.test.ts',
      // 00176 (plan kompletnej aplikacji, krok 3.1): wpłaty częściowe i historia; suma niecofniętych
      // wpłat = paid_amount, klucz idempotencji, obca firma, kwota, reszta, PLN, cofnięcie ze śladem.
      'tests/rls-wplaty-czesciowe.test.ts',
      // 00180 (plan kompletnej aplikacji, krok 3.2, część 1): import wyciągu; duplikaty po kluczu, wpłata
      // dopiero po potwierdzeniu i raz, maskowanie po „Pomiń”, cofnięcie ze śladem, obca firma i role.
      'tests/rls-wyciag-bankowy.test.ts',
      // 00178 (plan kompletnej aplikacji, krok 6.4): zlecenia archiwum dokumentów; owner/admin, izolacja firm,
      // limit 10 minut i zamykanie utkniętych (wyzwalacz), jedno aktywne na okres, CHECK-i pliku i okresu.
      'tests/rls-archiwum-dokumentow.test.ts',
      // 00179 (plan kompletnej aplikacji, krok 2.10): link do faktury dla nabywcy; polityki, granty kolumnowe,
      // cofnięcie jednokierunkowe i funkcja odczytu publicznego (ważny, wygasły, cofnięty, cudzy token).
      'tests/rls-link-dla-nabywcy.test.ts',
      // 00182 (plan kompletnej aplikacji, krok 7.3): adres kalendarza; skrót tokenu tylko do zapisu,
      // odczyt publiczny przez `calendar_feed_tenant` wyłącznie dla service_role.
      'tests/rls-kalendarz.test.ts',
      // 00185 (krok 6.2 planu kompletnej aplikacji, „Moi klienci”): podsumowanie tylko firm
      // z aktywnym członkostwem zalogowanego, bez względu na nagłówek aktywnej firmy; z cudzej nic.
      'tests/rls-moi-klienci.test.ts',
      // 00181 (plan kompletnej aplikacji, krok 7.1): klucze API firmy (owner/admin, skrót, odwołanie
      // nieodwracalne, audyt wyzwalaczem) i rola `api_key_client`: tylko firma i zakres klucza, bez zapisu.
      'tests/rls-api-klucze.test.ts',
      // 00184 (krok 7.1, część 2): wystawianie faktur kluczem z `invoices:write` przez
      // `api_create_invoice()`, idempotencja w transakcji z fakturą, izolacja firm.
      'tests/rls-api-wystawianie.test.ts',
      // 00189 (plan kompletnej aplikacji, krok 3.2, część 2): przelewy do ZUS i urzędu z wyciągu
      // jako zapłaty rozliczeń; rachunek firmy, wyłącznik modułu, zapis raz, role, różnica kwot, cofnięcie.
      'tests/rls-wyciag-podatki.test.ts',
      // 00187 (krok 7.1, część 3): webhooki owner/admin z kodem przy dodaniu, szyfrogram sekretu
      // bez odczytu, jedna dostawa na zdarzenie, ponowienia, wyłączenie po 20 porażkach, audyt.
      'tests/rls-webhooki.test.ts',
      // 00188 (plan kompletnej aplikacji, krok 8.1, część 2): dzwonek w aplikacji; wpis dla każdego
      // aktywnego członka firmy, UNIQUE bez dubli przy ponowieniu, odczyt tylko własnych wpisów aktywnej
      // firmy, bez zapisu kluczem użytkownika, oznaczanie tylko przez RPC, CHECK linku.
      'tests/rls-powiadomienia-w-aplikacji.test.ts',
      // 00190 (krok 6.4, część 2): znacznik usunięcia pliku paczki tylko przez funkcję zadania
      // (service_role), w jednej transakcji z audit_logs; CHECK znacznika; runner sprzątania przez PostgREST.
      'tests/rls-archiwum-sprzatanie.test.ts',
      // 00192 (plan kompletnej aplikacji, krok 6.2, część 3): komentarze i prośby o dokument przy koszcie;
      // odczyt tylko przy koszcie widocznym dla czytającego, zapis tylko przez funkcje, dzwonek bez autora,
      // ponowienie z tym samym identyfikatorem bez dubla, załatwienie (kto i kiedy) z audytem, CHECK-i.
      'tests/rls-komentarze-kosztow.test.ts',
      // 00193 (plan kompletnej aplikacji, krok 2.9): noty obciążeniowe i uznaniowe; izolacja firm,
      // rola jak przy fakturach, numer z bazy bez dubli naraz, wystawionej nie zmienia nikt, historia wysyłek.
      'tests/rls-noty.test.ts',
      // 00194 (plan kompletnej aplikacji, krok 3.7): kasa; numer KP i KW z bazy pod blokadą serii,
      // stan kasy nie poniżej zera, korekta (storno), wpłata do faktury przez 00176, RLS i niezmienność.
      'tests/rls-kasa.test.ts',
      // 00175 (plan kompletnej aplikacji, krok 1.3): faktura do paragonu ze skrzynki KSeF i paragon
      // z NIP; połączenie, ostrzeżenie, ponowienie bez zmian, decyzja klienta, wyzwalacz KPiR, izolacja.
      'tests/rls-faktura-do-paragonu.test.ts',
      // 00177 (plan kompletnej aplikacji, krok 3.4): koszty do zapłaty; RPC zapłaty i cofnięcia
      // (idempotencja, blokada wiersza, role, obca firma, audyt), wyzwalacz kolumn płatności, lista przez RLS.
      'tests/rls-koszty-do-zaplaty.test.ts',
      // 00191 (plan kompletnej aplikacji, krok 1.4, część 2): identyfikatory zbiorcze KSeF; RPC rezerwacji,
      // zapisu i porażki (jeden wiersz na zestaw faktur, próba w toku, przejęcie po 5 minutach), role owner/admin,
      // izolacja firm, brak zapisu z sesji poza RPC, żeton próby poza odczytem, wyzwalacz niezmienności.
      'tests/rls-identyfikator-zbiorczy.test.ts',
      // 00195 (plan kompletnej aplikacji, krok 6.2, część 4): uprawnienia biura rachunkowego w KSeF;
      // rezerwacja, przejęcie po 5 minutach, żeton i numery operacji, krok kodu, tylko właściciel,
      // izolacja firm, wyzwalacz przejść stanów.
      'tests/rls-uprawnienia-ksef.test.ts',
      // 00196 (plan kompletnej aplikacji, krok 3.2, część 3): przelewy do dostawców z wyciągu jako zapłaty kosztów;
      // zapis dopiero po decyzji klienta (CHECK także dla klucza serwisowego), „Pomiń” bez danych osób trzecich,
      // rachunek z faktury, kwota równa sumie do zapłaty, raz, role, obca firma, cofnięcie przez undo_expense_paid.
      'tests/rls-wyciag-koszty.test.ts',
      // 00197 (plan kompletnej aplikacji, krok 8.1, część 3): wpis w dzwonku przy wpłacie do faktury;
      // prawdziwe RPC wpłat z sesji, runner kolejki przez PostgREST, odbiorcy, ponowienie bez dubla,
      // stan po wpłacie, wpłata cofnięta i usunięta, obca firma, CHECK rodzajów.
      'tests/rls-dzwonek-wplaty.test.ts',
      // 00186 (plan skalowania 3000, sesja 21): wynik strażnika cyklu życia przed i po, lekka funkcja bez I3,
      // wklejanie ksef_upo_expected, indeksy cronów w planach, UNIQUE katalogu produktów i kontrola dubli.
      'tests/rls-indeksy-cronow-produkty.test.ts',
      // Plan skalowania 3000, sesja 12 (QAL-01, bez migracji): nocna kopia JSON czyta
      // tabele stronami po kluczu; filtry kursora (też klucz złożony) przez prawdziwy PostgREST.
      'tests/rls-kopia-json-stronicowanie.test.ts',
      // 00198 (plan kompletnej aplikacji, krok 2.4): proforma i oferta; izolacja firm, rola jak przy
      // fakturach, numer z bazy bez dubli naraz, wystawionego nie zmienia nikt, kwoty w CHECK-ach,
      // historia wysyłek, powiązanie z fakturą w INSERT (jedna faktura na numer zamiany), poza przychodem.
      'tests/rls-proformy.test.ts',
      // 00199 (plan kompletnej aplikacji, krok 2.5): serie numeracji faktur; dwa i pięć wystawień naraz
      // w jednej serii dają różne kolejne numery (blokada serii w wyzwalaczu), obca firma, role, wzór
      // bez licznika, numer zajęty w KSeF nie wraca z licznika, istniejące numery bez zmian.
      'tests/rls-numeracja.test.ts',
      // Plan aplikacji mobilnej, M6 (bez migracji): API `/api/mobile/v1` z tokenu sesji telefonu;
      // które tokeny GoTrue uznaje (anon, serwisowy, podrobiony, wylogowany: odmowa, nie awaria),
      // AAL1 i AAL2 z prawdziwym TOTP, lista firm i x-active-org przez RLS, filtr wpisu logowania.
      'tests/rls-mobile-api.test.ts',
      // Plan aplikacji mobilnej, M6b (D16, bez migracji): logowanie hasłem przez API kluczem serwisowym;
      // zwykła sesja klienta, odmowy, TOTP z kodem w telefonie, odświeżenie kluczem anon. Z
      // RLS_TEST_GOTRUE_CAPTCHA=on (stos z captchą w GoTrue, nie w CI) także odmowa klucza anon.
      'tests/rls-mobile-logowanie.test.ts',
      // 00201 (plan aplikacji mobilnej, M8): szkic faktury z telefonu tą samą funkcją co strona, klientem
      // z tokenem; klucze idempotencji: własne konto i firma, UNIQUE, klucz złożony z firmą, bez UPDATE
      // i DELETE dla klienta, usunięcie szkicu usuwa klucz.
      'tests/rls-mobile-faktury.test.ts',
    ],
    exclude: [],
    setupFiles: ['./tests/setup-rls.ts'],
  },
});
