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
      // 00181 (plan kompletnej aplikacji, krok 7.1): klucze API firmy (owner/admin, skrót, odwołanie
      // nieodwracalne, audyt wyzwalaczem) i rola `api_key_client`: tylko firma i zakres klucza, bez zapisu.
      'tests/rls-api-klucze.test.ts',
      // 00184 (krok 7.1, część 2): wystawianie faktur kluczem z `invoices:write` przez
      // `api_create_invoice()`, idempotencja w transakcji z fakturą, izolacja firm.
      'tests/rls-api-wystawianie.test.ts',
    ],
    exclude: [],
    setupFiles: ['./tests/setup-rls.ts'],
  },
});
