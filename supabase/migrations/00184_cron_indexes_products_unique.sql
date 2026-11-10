-- 00184_cron_indexes_products_unique.sql
--
-- Plan skalowania 3000, sesja 21 (ustalenia DB-02, DB-V02, DB-08 z raportu
-- „Pojemność FaktWay” + osobne ustalenie z #345). Cztery części, jedna
-- transakcja, bez zmian danych:
--
-- 1. Indeksy częściowe pod crony KSeF. Crony czytają faktury WSZYSTKICH firm
--    (bez tenant_id), a indeksy invoices zaczynają się od tenant_id, więc
--    każde przejście było skanem całej tabeli. Indeksy pasują do zapytań,
--    które już są w kodzie (kodu cronów ta migracja nie zmienia):
--      - idx_invoices_ksef_status_in_flight — stany w drodze i błędy:
--        ksef_lifecycle_violations I1, I2, I4, I5D, I9; critical-alerts-monitor
--        („sending” bez dzierżawy i po czasie); kandydaci ponowień w
--        ksef-lifecycle-reconcile (failed);
--      - idx_invoices_outgoing_number_not_accepted — critical-alerts-monitor:
--        faktura wychodząca z numerem KSeF, a nie „accepted” (anomalia, ~0 wierszy);
--      - idx_invoices_last_error_code — critical-alerts-monitor
--        (ROZ_HOLD_RECONCILE), I5D, kandydaci ponowień po kodzie;
--      - idx_invoices_inbox_pending_full_fetch — inbox-backfill: faktury ze
--        skrzynki czekające na pełne pobranie (znacznik _pendingFullFetch);
--      - idx_ksef_submissions_open_status — I5 (otwarte intent/sent starsze
--        niż 48 h) i podzapytanie I3K (number_taken).
--    Koszt zapisu (aktualizacje HOT): ksef_status, direction, ksef_number,
--    origin i created_at mają już indeksy, więc pierwsze dwa nie zmieniają
--    nic. Nowe kolumny w indeksach to last_error_code i fa3_data (warunek
--    indeksu skrzynki): UPDATE zmieniający któreś z nich nie jest już HOT.
--    last_error_code zmienia się zwykle razem z ksef_status (i tak nie-HOT);
--    fa3_data — przy edycji szkicu (świadomy koszt, opis w PR).
--
-- 2. ksef_upo_expected da się wkleić w zapytanie. Wersja z 00155 miała
--    SET search_path i EXISTS w ciele, a planista nie wkleja funkcji SQL
--    z SET ani z podzapytaniem: I3 i upo-retry-stale wołały ją osobno dla
--    każdej przyjętej faktury (z zapisem i odtworzeniem ustawień przy każdym
--    wywołaniu). Teraz: wyrażenie bez SET i bez podzapytania (SQL, STABLE,
--    SECURITY INVOKER, nazwy z prefiksem schematu), a EXISTS w osobnej
--    funkcji pomocniczej ksef_upo_expected_submission, liczonej tylko dla
--    faktur z historii KSeF (origin = ksef_import; OR kończy się na pierwszym
--    true). Wynik ten sam: IS DISTINCT FROM i EXISTS nigdy nie dają NULL.
--    Uprawnienia bez zmian: EXECUTE tylko service_role (planista wkleja
--    funkcję tylko roli z EXECUTE, więc klient dalej dostaje błąd).
--    Sygnatura bez zmian: PostgREST dalej widzi pole wyliczane.
--
-- 3. ksef_lifecycle_violations_without_i3(): pełna funkcja (00156) bez bloku
--    I3, dla crona uzgadniania (co 15 min; czyta tylko I1 i I5). Pełna
--    funkcja zostaje bez zmian (raport, monitor, panel). Obie muszą mieć ten
--    sam tekst bloków — pilnuje tests/unit/ksef-cykl-zycia-bez-i3.test.ts.
--
-- 4. Indeksy pod klucze obce (DB-08) i katalog produktów (#345):
--      - idx_ksef_send_attempts_invoice_id (invoice_id) — ON DELETE CASCADE
--        z invoices szukał wierszy bez indeksu na invoice_id na początku;
--      - idx_ocr_jobs_expense (expense_id) — ON DELETE SET NULL z expenses;
--      - idx_products_tenant_id (tenant_id, id) — odczyt katalogu stronami
--        po kluczu w imporcie (readAllById);
--      - uq_products_tenant_catalog_key — UNIQUE na kluczu katalogu, tym
--        samym co normalizeProductKey w lib/import/import-engine.ts: nazwa
--        bez skrajnych odstępów, odstępy zwinięte do jednej spacji, małe
--        litery; jednostka bez skrajnych odstępów, małe litery. Każda część
--        przez md5 zamiast samego tekstu: nazwa z pliku CSV nie ma limitu
--        długości, a wpis btree ma (ok. 2,7 kB). Dwa importy naraz nie tworzą już dubla:
--        przegrany dostaje 23505, a import przechodzi wtedy na zapis wiersz
--        po wierszu i pomija zajęte pozycje (ta sama zmiana w PR).
--      Na products nie wskazuje żaden klucz obcy (sprawdzone w migracjach).
--
-- WGRANIE: przed wdrożeniem, poza godzinami pracy. Addytywna: stary kod
-- działa z nową bazą (woła tę samą pełną funkcję i ten sam predykat;
-- unikalność produktów stary import przeżywa jak każdy błąd zapisu katalogu:
-- ostrzeżenie, faktury się zapisują). Nowy kod bez migracji: cron uzgadniania
-- wraca do pełnej funkcji z ostrzeżeniem w logu (PGRST202).
--
-- PRZED: liczenie dubli katalogu (tylko odczyt) musi dać 0 wierszy, inaczej
-- preflight przerwie migrację:
--   SELECT tenant_id,
--          lower(btrim(regexp_replace(name, '\s+', ' ', 'g'))) AS nazwa,
--          lower(regexp_replace(unit, '^\s+|\s+$', '', 'g')) AS jednostka,
--          count(*) AS wierszy,
--          array_agg(id ORDER BY created_at, id) AS produkty
--     FROM public.products
--    GROUP BY tenant_id, 2, 3
--   HAVING count(*) > 1;
-- Duble rozstrzyga Bartosz, osobno i za swoją zgodą (ta migracja niczego nie
-- usuwa i nie scala): w grupie zostaje najstarszy wiersz (pierwszy w
-- `produkty`), dostaje sumę use_count, największe last_used_at i
-- uzupełnione puste pola (cena, stawka, PKWiU, GTU, opis) z pozostałych;
-- pozostałe wiersze grupy usunąć. Klucze obce na products nie istnieją,
-- więc nic innego się nie zmienia (pozycje faktur trzymają nazwę, nie id).
--
-- BLOKADA: SHARE na products, invoices, ksef_submissions, ksef_send_attempts
-- i ocr_jobs do końca transakcji, brane od razu na początku. Odczyty działają,
-- zapisy do tych tabel czekają, aż zbudują się indeksy (każdy CREATE INDEX
-- czyta całą tabelę; przy bazie ok. 200 MB to kilka sekund). Zapis przez
-- PostgREST czekający dłużej niż jego limit (8 s) dostanie błąd i ponowienie
-- joba. lock_timeout 5 s: przy zajętej tabeli migracja pada (55P03) zamiast
-- ustawiać za sobą kolejkę — powtórzyć później. W najgorszym razie transakcja
-- aplikacji pisząca do dwóch z tych tabel dostaje zakleszczenie (40P01)
-- i ponowienie. Bez CONCURRENTLY: scripts/ops/wgraj-migracje.sh puszcza plik
-- jedną transakcją, a CONCURRENTLY w transakcji nie działa. Ostrzeżenia psql
-- o transakcji przy --single-transaction są oczekiwane, jak przy 00164.
--
-- PO: schema_migrations ('00184','cron_indexes_products_unique'), NOTIFY pgrst
-- (jest też na końcu pliku), weryfikacja (tylko odczyt):
--   SELECT c.relname, i.indisunique, i.indisvalid
--     FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--    WHERE c.relname IN ('idx_invoices_ksef_status_in_flight',
--          'idx_invoices_outgoing_number_not_accepted', 'idx_invoices_last_error_code',
--          'idx_invoices_inbox_pending_full_fetch', 'idx_ksef_submissions_open_status',
--          'idx_ksef_send_attempts_invoice_id', 'idx_ocr_jobs_expense',
--          'idx_products_tenant_id', 'uq_products_tenant_catalog_key');
--   -- 9 wierszy, indisvalid = true; uq_products_tenant_catalog_key unikalny.
--   SELECT proname, proconfig, prosecdef FROM pg_proc
--    WHERE proname IN ('ksef_upo_expected', 'ksef_upo_expected_submission',
--                      'ksef_lifecycle_violations_without_i3');
--   -- ksef_upo_expected: proconfig NULL, prosecdef false.
--   SELECT (SELECT count(*) FROM public.ksef_lifecycle_violations() WHERE invariant <> 'I3')
--        = (SELECT count(*) FROM public.ksef_lifecycle_violations_without_i3());  -- true
-- Zapytania EXPLAIN (ANALYZE, BUFFERS) przed i po są w opisie PR.
-- types/database.ts: dochodzą dwie funkcje (Functions), reszta bez zmian.
--
-- Wycofanie (bez utraty danych, za zgodą Bartosza): DROP INDEX dziewięciu
-- indeksów z listy wyżej, DROP FUNCTION
-- public.ksef_lifecycle_violations_without_i3() (najpierw cofnąć kod crona),
-- ksef_upo_expected z 00155 (CREATE OR REPLACE z tamtego pliku), potem DROP
-- FUNCTION public.ksef_upo_expected_submission(uuid, uuid, text).
BEGIN;

SET LOCAL lock_timeout = '5s';

LOCK TABLE public.products, public.invoices, public.ksef_submissions,
           public.ksef_send_attempts, public.ocr_jobs IN SHARE MODE;

-- ─────────────────────────────────────────────────────────────────
-- 1. Katalog produktów: najpierw kontrola dubli (przerywa, zanim cokolwiek powstanie)
-- ─────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_groups integer;
BEGIN
  SELECT count(*) INTO v_groups FROM (
    SELECT 1
      FROM public.products
     GROUP BY tenant_id,
              lower(btrim(regexp_replace(name, '\s+', ' ', 'g'))),
              lower(regexp_replace(unit, '^\s+|\s+$', '', 'g'))
    HAVING count(*) > 1
  ) AS duplicates;
  IF v_groups > 0 THEN
    RAISE EXCEPTION 'products ma duble w katalogu firmy (ta sama nazwa i jednostka): % grup. Rozwiąż je przed 00184 według nagłówka migracji (zapytanie PRZED), potem wgraj ją ponownie.', v_groups;
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_products_tenant_catalog_key
  ON public.products (
    tenant_id,
    md5(lower(btrim(regexp_replace(name, '\s+', ' ', 'g')))),
    md5(lower(regexp_replace(unit, '^\s+|\s+$', '', 'g')))
  );
COMMENT ON INDEX public.uq_products_tenant_catalog_key IS
  'Jeden produkt na klucz katalogu w firmie (00184, plan skalowania sesja 21): nazwa bez skrajnych odstępów, odstępy zwinięte, małe litery | jednostka bez skrajnych odstępów, małe litery — jak normalizeProductKey w lib/import/import-engine.ts. md5 każdej części, bo nazwa i jednostka nie mają limitu długości (wpis btree ma).';

CREATE INDEX IF NOT EXISTS idx_products_tenant_id
  ON public.products (tenant_id, id);
COMMENT ON INDEX public.idx_products_tenant_id IS
  'Odczyt katalogu firmy stronami po kluczu w imporcie (readAllById: tenant_id = …, id > kursor, ORDER BY id) — 00184.';

-- ─────────────────────────────────────────────────────────────────
-- 2. Indeksy częściowe pod crony KSeF (zapytania bez tenant_id)
-- ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_invoices_ksef_status_in_flight
  ON public.invoices (ksef_status)
  WHERE ksef_status IN ('queued', 'sending', 'failed', 'rejected');
COMMENT ON INDEX public.idx_invoices_ksef_status_in_flight IS
  'Crony bez tenant_id (00184): ksef_lifecycle_violations I1, I2, I4, I5D, I9; critical-alerts-monitor (sending); kandydaci ponowień ksef-lifecycle-reconcile (failed).';

CREATE INDEX IF NOT EXISTS idx_invoices_outgoing_number_not_accepted
  ON public.invoices (tenant_id)
  WHERE direction = 'outgoing' AND ksef_number IS NOT NULL
    AND (ksef_status IS NULL OR ksef_status <> 'accepted');
COMMENT ON INDEX public.idx_invoices_outgoing_number_not_accepted IS
  'critical-alerts-monitor (00184): faktura wychodząca z numerem KSeF, a nie accepted — anomalia, indeks prawie pusty.';

CREATE INDEX IF NOT EXISTS idx_invoices_last_error_code
  ON public.invoices (last_error_code)
  WHERE last_error_code IS NOT NULL;
COMMENT ON INDEX public.idx_invoices_last_error_code IS
  'Crony po kodzie błędu bez tenant_id (00184): critical-alerts-monitor (ROZ_HOLD_RECONCILE), I5D, kandydaci ponowień ksef-lifecycle-reconcile.';

CREATE INDEX IF NOT EXISTS idx_invoices_inbox_pending_full_fetch
  ON public.invoices (created_at)
  WHERE direction = 'incoming' AND origin = 'ksef_inbox'
    AND (fa3_data ->> '_pendingFullFetch') = 'true';
COMMENT ON INDEX public.idx_invoices_inbox_pending_full_fetch IS
  'inbox-backfill (00184): faktury ze skrzynki czekające na pełne pobranie, od najstarszej. fa3_data w warunku: UPDATE zmieniający fa3_data nie jest HOT (świadomy koszt).';

CREATE INDEX IF NOT EXISTS idx_ksef_submissions_open_status
  ON public.ksef_submissions (status, attempted_at)
  WHERE status IN ('intent', 'sent', 'number_taken');
COMMENT ON INDEX public.idx_ksef_submissions_open_status IS
  'ksef_lifecycle_violations (00184): I5 — otwarte intent/sent starsze niż 48 h; I3K — wpisy number_taken z decyzją importu.';

-- ─────────────────────────────────────────────────────────────────
-- 3. Indeksy pod klucze obce (DB-08)
-- ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_ksef_send_attempts_invoice_id
  ON public.ksef_send_attempts (invoice_id);
COMMENT ON INDEX public.idx_ksef_send_attempts_invoice_id IS
  'ON DELETE CASCADE z invoices (00184): wiersze faktury bez skanu całej tabeli (istniejący indeks zaczyna się od tenant_id).';

CREATE INDEX IF NOT EXISTS idx_ocr_jobs_expense
  ON public.ocr_jobs (expense_id)
  WHERE expense_id IS NOT NULL;
COMMENT ON INDEX public.idx_ocr_jobs_expense IS
  'ON DELETE SET NULL z expenses (00184): zadania OCR wydatku bez skanu całej tabeli.';

-- ─────────────────────────────────────────────────────────────────
-- 4. ksef_upo_expected do wklejenia w zapytanie + funkcja pomocnicza
-- ─────────────────────────────────────────────────────────────────
-- Pomocnicza: EXISTS z 00155 bez zmian (ta sama firma; ta sama faktura albo
-- numer KSeF faktury jako numer odpowiedzi lub numer oryginału 440 naszej
-- wysyłki). Bez SET (wołana wiersz po wierszu, ustawienia kosztowałyby przy
-- każdym wywołaniu), nazwy z prefiksem schematu, SECURITY INVOKER.
CREATE OR REPLACE FUNCTION public.ksef_upo_expected_submission(
  p_tenant_id uuid,
  p_invoice_id uuid,
  p_ksef_number text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.ksef_submissions s
     WHERE s.tenant_id = p_tenant_id
       AND (s.invoice_id = p_invoice_id
            OR (p_ksef_number IS NOT NULL
                AND (s.response_ksef_number = p_ksef_number
                     OR s.original_ksef_number = p_ksef_number))))
$$;
REVOKE ALL ON FUNCTION public.ksef_upo_expected_submission(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ksef_upo_expected_submission(uuid, uuid, text) TO service_role;
COMMENT ON FUNCTION public.ksef_upo_expected_submission(uuid, uuid, text) IS
  'Część ksef_upo_expected z podzapytaniem (00184): czy faktura (albo jej numer KSeF jako numer odpowiedzi lub oryginału 440) ma wpis naszej wysyłki w ksef_submissions tej firmy. Osobno, bo planista nie wkleja funkcji z podzapytaniem.';

CREATE OR REPLACE FUNCTION public.ksef_upo_expected(i public.invoices)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT i.origin IS DISTINCT FROM 'ksef_import'
      OR public.ksef_upo_expected_submission(i.tenant_id, i.id, i.ksef_number)
$$;
REVOKE ALL ON FUNCTION public.ksef_upo_expected(public.invoices) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ksef_upo_expected(public.invoices) TO service_role;
COMMENT ON FUNCTION public.ksef_upo_expected(public.invoices) IS
  'UPO istnieje tylko dla faktur wysłanych sesją FaktWay (00155, decyzja Bartosza 22.10.2026): true dla faktur spoza historii KSeF; dla origin = ksef_import tylko, gdy ksef_upo_expected_submission znajdzie wpis naszej wysyłki. 00184: bez SET i bez podzapytania, więc planista wkleja ją w zapytanie (I3, upo-retry-stale, raport) zamiast wołać dla każdego wiersza; wynik ten sam co w 00155. Pole wyliczane PostgREST; EXECUTE tylko service_role.';

-- ─────────────────────────────────────────────────────────────────
-- 5. Strażnik bez I3 dla crona uzgadniania
-- ─────────────────────────────────────────────────────────────────
-- Ciało ksef_lifecycle_violations() z 00156 znak w znak, bez bloku I3
-- (strażnik: tests/unit/ksef-cykl-zycia-bez-i3.test.ts). Zmiana pełnej
-- funkcji wymaga tej samej zmiany tutaj.
CREATE OR REPLACE FUNCTION public.ksef_lifecycle_violations_without_i3()
RETURNS TABLE (invariant text, invoice_id uuid, tenant_id uuid, detail jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- I1: queued > 15 min bez zlecenia w pg-boss.
  RETURN QUERY
    SELECT 'I1'::text, i.id, i.tenant_id,
           jsonb_build_object('updated_at', i.updated_at)
      FROM public.invoices i
     WHERE i.direction = 'outgoing'
       AND i.ksef_status = 'queued'
       AND i.updated_at < now() - interval '15 minutes'
       AND NOT EXISTS (
         SELECT 1 FROM pgboss.job j
          WHERE j.name = 'invoice.submit.requested'
            AND j.state IN ('created', 'retry', 'active')
            AND j.data->>'invoiceId' = i.id::text
       );

  -- I2: sending dłużej niż dzierżawa (15 min) + 15 min, albo bez znacznika przejęcia.
  RETURN QUERY
    SELECT 'I2'::text, i.id, i.tenant_id,
           jsonb_build_object('submitted_to_ksef_at', i.submitted_to_ksef_at, 'owner', i.ksef_send_owner)
      FROM public.invoices i
     WHERE i.direction = 'outgoing'
       AND i.ksef_status = 'sending'
       AND (i.submitted_to_ksef_at IS NULL OR i.submitted_to_ksef_at < now() - interval '30 minutes');

  -- I3K (00156): faktura zapisana z KSeF decyzją (zapis oryginału) bez sesji UPO
  -- albo bez daty nadania — trwały sygnał (T4, C6). Liczona od wpisów number_taken
  -- z decyzją importu (mało wierszy), nie od fa3_data wszystkich przyjętych faktur.
  -- Rzut identyfikatora tylko po sprawdzeniu wzorca (CASE). I3 K nie pokazuje:
  -- K ma zawsze wiersz upo_receipts (INV-18), a ksef_upo_expected(K) = true
  -- (sesja oryginału na K albo znacznik X z numerem K w ksef_submissions).
  RETURN QUERY
    SELECT 'I3K'::text, k.id, k.tenant_id,
           jsonb_build_object(
             'ksef_number', k.ksef_number,
             'no_session', NOT EXISTS (SELECT 1 FROM public.ksef_submissions s
                                        WHERE s.invoice_id = k.id AND s.tenant_id = k.tenant_id
                                          AND s.response_ksef_number = k.ksef_number
                                          AND s.session_reference_number IS NOT NULL),
             'no_date', k.ksef_accepted_at IS NULL,
             'upo_status', (SELECT u.status FROM public.upo_receipts u WHERE u.invoice_id = k.id))
      FROM public.invoices k
     WHERE k.id IN (SELECT CASE WHEN m.original_check->'decision'->>'importedInvoiceId'
                                     ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                THEN (m.original_check->'decision'->>'importedInvoiceId')::uuid END
                      FROM public.ksef_submissions m
                     WHERE m.status = 'number_taken'
                       AND m.original_check->'decision' ? 'importedInvoiceId')
       AND k.direction = 'outgoing'
       AND k.ksef_status = 'accepted'
       AND k.origin = 'ksef_import'
       AND (k.ksef_accepted_at IS NULL
            OR (NOT EXISTS (SELECT 1 FROM public.upo_receipts u
                             WHERE u.invoice_id = k.id AND u.status IN ('downloaded', 'archived'))
                AND NOT EXISTS (SELECT 1 FROM public.ksef_submissions s
                                 WHERE s.invoice_id = k.id AND s.tenant_id = k.tenant_id
                                   AND s.response_ksef_number = k.ksef_number
                                   AND s.session_reference_number IS NOT NULL)));

  -- I4: failed / rejected z kodem spoza katalogu albo z trzymanym przejęciem.
  RETURN QUERY
    SELECT 'I4'::text, i.id, i.tenant_id,
           jsonb_build_object('last_error_code', i.last_error_code, 'owner', i.ksef_send_owner)
      FROM public.invoices i
     WHERE i.direction = 'outgoing'
       AND i.ksef_status IN ('failed', 'rejected')
       AND (
         i.ksef_send_owner IS NOT NULL
         OR i.last_error_code IS NULL
         OR NOT EXISTS (SELECT 1 FROM public.ksef_error_codes c WHERE c.code = i.last_error_code)
       );

  -- I5: otwarty wpis `sent` albo zamiar `intent` starszy niż 48 h, a faktura nie jest w sending.
  -- 00148: bez faktur czekających na decyzję klienta (blokada decyzji NULL) — te są w I5D.
  -- 00156: bez przeglądu pliku (provenance-review — I5R; cron go nie uzgadnia, bez pętli);
  -- NULL <> … = NULL, więc I5D też wypada; recheck-needed zostaje w I5 (cron robi nową
  -- ocenę, INV-25).
  RETURN QUERY
    SELECT 'I5'::text, s.invoice_id, s.tenant_id,
           jsonb_build_object('attempted_at', s.attempted_at, 'session', s.session_reference_number,
                              'ksef_status', i.ksef_status, 'submission_status', s.status)
      FROM public.ksef_submissions s
      JOIN public.invoices i ON i.id = s.invoice_id
     WHERE s.status IN ('sent', 'intent')
       AND s.attempted_at < now() - interval '48 hours'
       AND i.ksef_status <> 'sending'
       AND public.ksef_duplicate_decision_blocker(s.invoice_id, s.tenant_id) <> 'provenance-review';  -- 00156: NULL (czeka na klienta) = I5D, przegląd = I5R

  -- I5D (00148): faktura czeka na decyzję klienta — nierozstrzygnięty 440 z kompletnymi
  -- danymi oryginału (blokada decyzji = NULL). I5R (00156): poprawna brama review —
  -- przegląd pliku z oznaczeniem FaktWay przez operatora (blokada provenance-review).
  -- Osobno od I5: cron żadnej z nich nie uzgadnia; alarm krytyczny I5D nie liczy
  -- (chyba że środowisko się nie zgadza), I5R po 72 h; raport — osobne wiersze.
  -- Jedno zapytanie, blokada liczona raz na fakturę (OFFSET 0 w podzapytaniu
  -- bocznym: bez niego planista wkleja wywołanie STABLE w CASE i WHERE).
  RETURN QUERY
    SELECT CASE WHEN b.code IS NULL THEN 'I5D' ELSE 'I5R' END, i.id, i.tenant_id,
           jsonb_build_object(
             'original_ksef_number', m.original_ksef_number,
             'reason', m.original_check->>'reason',
             'env', m.original_check->>'env',
             'checked_at', m.original_check->>'checkedAt',
             'attempted_at', m.attempted_at,
             'last_attempt_at', i.last_attempt_at,
             'problems', m.original_check->'importGate'->'problems')
      FROM public.invoices i
      CROSS JOIN LATERAL (
        SELECT s.original_ksef_number, s.original_check, s.attempted_at
          FROM public.ksef_submissions s
         WHERE s.invoice_id = i.id AND s.tenant_id = i.tenant_id
           AND s.status IN ('intent', 'sent') AND s.original_ksef_number IS NOT NULL
         ORDER BY s.attempted_at DESC NULLS LAST, s.id
         LIMIT 1) m
      CROSS JOIN LATERAL (
        SELECT public.ksef_duplicate_decision_blocker(i.id, i.tenant_id) AS code
        OFFSET 0) b
     WHERE i.direction = 'outgoing'
       AND i.ksef_status = 'failed'
       AND i.last_error_code = 'KSEF_DUPLICATE_RECONCILE'
       AND (b.code IS NULL OR b.code = 'provenance-review');

  -- I9: failed / rejected z numerem KSeF — stan sprzeczny, nic automatycznie.
  RETURN QUERY
    SELECT 'I9'::text, i.id, i.tenant_id,
           jsonb_build_object('ksef_number', i.ksef_number)
      FROM public.invoices i
     WHERE i.direction = 'outgoing'
       AND i.ksef_status IN ('failed', 'rejected')
       AND i.ksef_number IS NOT NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.ksef_lifecycle_violations_without_i3() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ksef_lifecycle_violations_without_i3() TO service_role;
COMMENT ON FUNCTION public.ksef_lifecycle_violations_without_i3() IS
  'ksef_lifecycle_violations() bez I3 (00184, plan skalowania sesja 21): dla crona uzgadniania (ksef-lifecycle-reconcile), który czyta tylko I1 i I5 — I3 to najdroższy blok (wszystkie przyjęte faktury wychodzące). Ciało znak w znak jak w pełnej funkcji poza blokiem I3; zmiana pełnej wymaga tej samej zmiany tutaj (tests/unit/ksef-cykl-zycia-bez-i3.test.ts).';

NOTIFY pgrst, 'reload schema';

COMMIT;
