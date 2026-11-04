-- 00148_ksef_duplicate_decision.sql
--
-- D-A4-1b-3, PR B (plan „zero zgubionych faktur”): decyzja klienta przy
-- nierozstrzygniętym duplikacie 440 (decyzje Bartosza 04.10 i 07.10.2026).
-- Klient (właściciel/administrator) albo operator na jego prośbę zapisuje:
-- „ta sama sprzedaż” albo „inna sprzedaż”. W PR B powody `no-own-file`
-- (oryginał z innego programu, brak naszego pliku) i `known-number` (numer
-- KSeF oryginału ma inna, przyjęta faktura sprzedaży firmy — od PR B runner
-- pobiera oryginał także wtedy, 07.10 (1)), tylko zwykła faktura. Obie decyzje
-- wycofują nasz dokument — nic nie importujemy (07.10 (A)), wpłaty blokują
-- decyzję (07.10 (A)); teksty klienta i komunikaty P0001 z tej migracji
-- przechodzą przegląd prawnika przed KSeF PROD (07.10 (A), (8); TEST bez blokady).
-- Komunikaty odmów: RAISE z własnymi znacznikami %, bez format().
--
-- 1. ksef_duplicate_check_allows(jsonb, text) — czy dane oryginału pozwalają
--    na decyzję (lustro TS: duplicateCheckAllows).
-- 2. ksef_duplicate_decision_blocker(uuid, uuid) — pierwszy powód, dla
--    którego faktura nie czeka na decyzję (NULL = czeka); known-stale, gdy
--    faktura ze znanym numerem KSeF już go nie ma albo nie jest przyjęta.
-- 3. decide_ksef_duplicate(...) — jedna transakcja: wszystkie wpisy
--    intent/sent/duplicate → number_taken z `decision` na znaczniku, powrót do
--    szkicu z tymi samymi polami co reset_ksef_send (numer zostaje), audyt
--    invoice.ksef_duplicate_decided + invoice.send_reset z prawdziwym
--    poprzednim stanem. Powtórzenie tej samej decyzji = already_decided.
-- 4. Wyzwalacze szkicu wycofanego (wpis number_taken — decyzja albo
--    automatyczny „numer zajęty”, 07.10 (2), (3), (9), (11)), jedna funkcja:
--    c_guard_ksef_retired_draft — szkic nie wychodzi ze stanu draft
--    (przejęcie, kolejkowanie, zapis porażki ani akceptacji; każda rola).
--    Wyzwalacz, nie warunek w claim_ksef_send: podzapytanie w WHERE
--    czekającego UPDATE widzi starą migawkę (EvalPlanQual), zapytanie
--    wyzwalacza — świeżą.
--    c_guard_ksef_retired_draft_delete — sesja klienta nie usuwa szkicu
--    wycofanego zwykłej faktury ani zaliczki (numer zostaje przy nim; usuwa
--    tylko serwis za zgodą Bartosza) niezależnie od kierunku: WHEN nie sprawdza
--    direction, bo klient mógłby go najpierw zmienić. Korekta i faktura
--    rozliczeniowa zostają usuwalne: niewyrzucalny szkic korekty blokowałby
--    kolejną korektę (00133/00135), a szkic ROZ trzyma swoje zaliczki (00125).
--    c_guard_ksef_retired_draft_number — sesja klienta nie zmienia numeru
--    ani kierunku szkicu wycofanego (każdy rodzaj; faktura zakupowa wypada
--    z indeksu unikalnego numerów sprzedaży 00120); serwis może.
-- 5. ksef_lifecycle_violations: I5 bez faktur czekających na decyzję klienta
--    i nowy wiersz I5D „czeka na klienta” (definicja z 00136 + warunek I5
--    + blok I5D; 07.10 (4)).
-- 6. Katalog: komunikat KSEF_NUMBER_TAKEN bez „usuń go” (jeden wiersz
--    referencyjny, jak 00143; 07.10 (3)).
--
-- PRZED wdrożeniem kodu: nowe funkcje i wyzwalacze, jeden UPDATE wiersza
-- katalogu (nie dane klientów), bez DELETE, bez DROP poza DROP TRIGGER IF
-- EXISTS trzech nowych wyzwalaczy. Stary kod nie woła decyzji; zmienia się
-- dla niego: szkicu z wpisem number_taken nie da się wysłać (dziś powtórne
-- 440; odmowa P0001 przechodzi przez describeKsefSendError), usunąć z sesji
-- klienta, jeśli to zwykła faktura albo zaliczka (stary kod pokaże ogólne
-- „Nie udało się usunąć szkicu”), ani przenumerować czy zmienić na fakturę
-- zakupową z sesji klienta (stary kod nie robi żadnej z tych zmian);
-- stary monitor liczy I5D jak każde naruszenie (alarm
-- krytyczny). Na produkcji 07.10: 0 faktur KSEF_DUPLICATE_RECONCILE,
-- 0 wpisów number_taken, 0 wpłat — w oknie migracja→wdrożenie żaden z tych
-- przypadków nie wystąpi. Wdrożenie: worker (id=2), potem web (id=1).
--
-- Wycofanie (decyzja Bartosza): DROP TRIGGER c_guard_ksef_retired_draft,
-- c_guard_ksef_retired_draft_delete, c_guard_ksef_retired_draft_number
-- (ten ostatni strzeże numeru i kierunku);
-- DROP FUNCTION decide_ksef_duplicate, ksef_duplicate_decision_blocker,
-- ksef_duplicate_check_allows, guard_ksef_retired_draft;
-- ksef_lifecycle_violations z 00136; komunikat KSEF_NUMBER_TAKEN z 00142.
-- Uwaga: wycofane dokumenty zostają szkicami z number_taken — bez wyzwalaczy
-- znów dałoby się je wysłać (powtórne 440), usunąć, przenumerować i zmienić
-- na fakturę zakupową (numer wraca do podpowiedzi albo wypada z indeksu
-- unikalnego numerów sprzedaży).
--
-- Przed uruchomieniem (sesja lokalna, AGENTS.md „Wgrywanie migracji”):
--   SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 3;
--     → ostatnia 00147;
--   SELECT count(*) FROM public.ksef_error_codes WHERE code = 'KSEF_NUMBER_TAKEN';
--     → 1 (jedyny UPDATE w pliku dotyka dokładnie tego wiersza katalogu).

BEGIN;

-- ─────────────────────────────────────────────────────────────────
-- 1. Polityka danych oryginału (lustro TS: duplicateCheckAllows)
-- ─────────────────────────────────────────────────────────────────
-- Czysta funkcja jsonb. p_choice NULL = dowolny wybór (blokada, I5D, cron).
-- Typy sprawdzane jawnie, żeby SQL i TS zgadzały się na dziwnych wartościach
-- (v:"1", liczbowe knownInvoice.id). `recheck` (późniejsze nieudane
-- sprawdzenie) nie blokuje: dane z wcześniejszego udanego sprawdzenia są
-- dalej prawdziwe, faktura w KSeF się nie zmienia.
-- no-own-file: runner zawsze ustawia ownHistory; FaktFlow wpisuje SystemInfo
-- w każdym generatorze, więc ownHistory = true przy oryginale z innego
-- programu to sprzeczność — oba wybory odmawiają.
-- known-number: ownHistory = „K może być naszą wysyłką tego dokumentu”;
-- true albo NULL odmawia. Program w summary.systemInfo nie ma znaczenia
-- (Y jest zapisem K w FaktFlow; decyzja 12 z 07.10).
CREATE OR REPLACE FUNCTION public.ksef_duplicate_check_allows(
  p_check jsonb,
  p_choice text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT COALESCE(
    jsonb_typeof(p_check) = 'object'
    AND p_check->'v' = '1'::jsonb
    AND NOT (p_check ? 'decision')
    AND (p_choice IS NULL OR p_choice IN ('same_sale', 'other_sale'))
    AND p_check->>'reason' IN ('no-own-file', 'known-number')        -- PR B (07.10 (1)); PR C poszerzy przez CREATE OR REPLACE
    AND jsonb_typeof(p_check->'sha256') = 'string'
    AND p_check->>'sha256' ~ '^[0-9a-f]{64}$'                       -- dane oryginału są wymagane (04.10)
    AND jsonb_typeof(p_check->'summary') = 'object'
    AND p_check->'ownHistory' = 'false'::jsonb                        -- NULL (nie wiadomo) odmawia; true = oryginał może być nasz
    AND (p_check->>'reason' <> 'known-number'
         OR (jsonb_typeof(p_check->'knownInvoice'->'id') = 'string'
             AND p_check->'knownInvoice'->>'id' <> '')),
    false);
$$;
REVOKE ALL ON FUNCTION public.ksef_duplicate_check_allows(jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ksef_duplicate_check_allows(jsonb, text) TO service_role;
COMMENT ON FUNCTION public.ksef_duplicate_check_allows(jsonb, text) IS
  'Czy dane oryginału z original_check pozwalają klientowi zdecydować o duplikacie 440 (00148): v 1, bez decision, powód no-own-file albo known-number, sha256 oryginału, summary, ownHistory false, przy known-number knownInvoice.id. Lustro TS: duplicateCheckAllows (lib/ksef/duplicate-decision.ts).';

-- ─────────────────────────────────────────────────────────────────
-- 2. Blokada decyzji (NULL = faktura czeka na decyzję klienta)
-- ─────────────────────────────────────────────────────────────────
-- Pierwszy pasujący kod w kolejności 1–13 (lustro TS: duplicateDecisionOptions).
-- Nie sprawdza środowiska, roli wywołującego ani dzierżawy. Używają jej RPC,
-- I5/I5D, powiadomienie klienta i przypomnienie operatora.
-- SECURITY INVOKER: wołana z ksef_lifecycle_violations (DEFINER) działa jako
-- właściciel i czyta payments; serwis ma SELECT na payments (00074).
-- Inne otwarte wpisy bez znacznika nie są odmową: decyzja zamyka wszystkie
-- intent/sent/duplicate, jak automatyczne markKsefSubmissionsNumberTaken —
-- oryginał o tym numerze jest w KSeF jeden (to K), więc żadna nasza inna
-- próba tam nie jest.
CREATE OR REPLACE FUNCTION public.ksef_duplicate_decision_blocker(
  p_invoice_id uuid,
  p_tenant_id uuid
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_inv public.invoices;
  v_marker public.ksef_submissions;
BEGIN
  -- 1. not-found: brak faktury wychodzącej o tym id w tej firmie.
  SELECT i.* INTO v_inv
    FROM public.invoices i
   WHERE i.id = p_invoice_id
     AND i.tenant_id = p_tenant_id
     AND i.direction = 'outgoing';
  IF NOT FOUND THEN
    RETURN 'not-found';
  END IF;

  -- 2. not-pending: tylko failed KSEF_DUPLICATE_RECONCILE czeka na decyzję.
  IF v_inv.ksef_status IS DISTINCT FROM 'failed'
     OR v_inv.last_error_code IS DISTINCT FROM 'KSEF_DUPLICATE_RECONCILE' THEN
    RETURN 'not-pending';
  END IF;

  -- 3. in-ksef: numer KSeF na fakturze albo przyjęta próba / numer z odpowiedzi.
  IF v_inv.ksef_number IS NOT NULL OR EXISTS (
    SELECT 1 FROM public.ksef_submissions s
     WHERE s.invoice_id = p_invoice_id
       AND s.tenant_id = p_tenant_id
       AND (s.status = 'accepted' OR s.response_ksef_number IS NOT NULL)
  ) THEN
    RETURN 'in-ksef';
  END IF;

  -- 4. kind: KOR, ZAL i ROZ bez decyzji w PR B (D-A4-1b-3-S).
  IF COALESCE(v_inv.invoice_kind::text, 'regular') <> 'regular' THEN
    RETURN 'kind';
  END IF;

  -- 5. billing: faktura abonamentu FaktFlow.
  IF v_inv.stripe_invoice_id IS NOT NULL THEN
    RETURN 'billing';
  END IF;

  -- 6. offline: reset ich nie czyści (00131), 00132 je zamraża.
  IF v_inv.offline_idempotency_key IS NOT NULL
     OR v_inv.offline_qr_offline IS NOT NULL
     OR v_inv.offline_qr_certyfikat IS NOT NULL THEN
    RETURN 'offline';
  END IF;

  -- 7. no-marker: znacznik = najnowszy wpis intent/sent z numerem oryginału.
  SELECT s.* INTO v_marker
    FROM public.ksef_submissions s
   WHERE s.invoice_id = p_invoice_id
     AND s.tenant_id = p_tenant_id
     AND s.status IN ('intent', 'sent')
     AND s.original_ksef_number IS NOT NULL
   ORDER BY s.attempted_at DESC NULLS LAST, s.id
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN 'no-marker';
  END IF;

  -- 8. conflicting-originals: wpis w dowolnym stanie z innym numerem oryginału.
  IF EXISTS (
    SELECT 1 FROM public.ksef_submissions s
     WHERE s.invoice_id = p_invoice_id
       AND s.tenant_id = p_tenant_id
       AND s.original_ksef_number IS NOT NULL
       AND s.original_ksef_number <> v_marker.original_ksef_number
  ) THEN
    RETURN 'conflicting-originals';
  END IF;

  -- 9. no-check: znacznik sprzed 00144.
  IF v_marker.original_check IS NULL THEN
    RETURN 'no-check';
  END IF;

  -- 10. reason: polityka danych oryginału (także known-number PR A bez danych
  --     i ownHistory w JSON).
  IF NOT public.ksef_duplicate_check_allows(v_marker.original_check, NULL) THEN
    RETURN 'reason';
  END IF;

  -- 11. known-stale (tylko powód known-number, C2): faktura Y firmy, którą
  --     klient zobaczy jako zapis K w FaktFlow, musi dalej mieć K i być
  --     przyjęta (uwaga 1 sprawdzenia). Porównanie jako tekst — zniekształcone
  --     id nie rzuca błędem rzutowania.
  IF v_marker.original_check->>'reason' = 'known-number' AND NOT EXISTS (
    SELECT 1 FROM public.invoices y
     WHERE y.tenant_id = p_tenant_id
       AND y.direction = 'outgoing'
       AND y.ksef_status = 'accepted'
       AND y.id <> p_invoice_id
       AND y.id::text = v_marker.original_check->'knownInvoice'->>'id'
       AND y.ksef_number = v_marker.original_ksef_number
  ) THEN
    RETURN 'known-stale';
  END IF;

  -- 12. own-history: historia sprawdzana w bazie, nie brana z JSON — sesja
  --     oryginału albo plik oryginału w którejś próbie tej faktury.
  IF EXISTS (
    SELECT 1 FROM public.ksef_submissions s
     WHERE s.invoice_id = p_invoice_id
       AND s.tenant_id = p_tenant_id
       AND ((v_marker.original_session_reference_number IS NOT NULL
             AND s.session_reference_number = v_marker.original_session_reference_number)
            OR lower(s.request_payload_hash) = v_marker.original_check->>'sha256')
  ) THEN
    RETURN 'own-history';
  END IF;

  -- 13. payments: wpłaty blokują decyzję (07.10 (A)); wiersze abonamentu
  --     odpadły wcześniej (5).
  IF COALESCE(v_inv.paid_amount, 0) <> 0 OR EXISTS (
    SELECT 1 FROM public.payments p
     WHERE p.tenant_id = p_tenant_id
       AND p.invoice_id = p_invoice_id
  ) THEN
    RETURN 'payments';
  END IF;

  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.ksef_duplicate_decision_blocker(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ksef_duplicate_decision_blocker(uuid, uuid) TO service_role;
COMMENT ON FUNCTION public.ksef_duplicate_decision_blocker(uuid, uuid) IS
  'Pierwszy powód, dla którego faktura nie czeka na decyzję klienta przy duplikacie 440 (00148): not-found, not-pending, in-ksef, kind, billing, offline, no-marker, conflicting-originals, no-check, reason, known-stale, own-history, payments; NULL = czeka (I5D). Lustro TS: duplicateDecisionOptions.';

-- ─────────────────────────────────────────────────────────────────
-- 3. Decyzja klienta (RPC serwera)
-- ─────────────────────────────────────────────────────────────────
-- Każda odmowa to RAISE: transakcja się cofa, nic się nie zmienia. Teksty
-- odmów (DUPLICATE_DECISION_SQL_TEXTS w TS) — RAISE z własnymi znacznikami %.
-- Bez odmowy dzierżawy: panel pojawia się dopiero po onExhausted, w oknie
-- 15 min ostatniego przejęcia; żywą jeszcze próbę zatrzymuje wyzwalacz (4),
-- a KSeF i tak odpowiedziałby 440, bo K istnieje.
-- Aktor i notatka trafiają tylko do audytu — original_check czyta klient
-- (00002).
CREATE OR REPLACE FUNCTION public.decide_ksef_duplicate(
  p_invoice_id uuid,
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_choice text,
  p_via text,
  p_original_ksef_number text,
  p_original_sha256 text,
  p_env text,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_inv public.invoices;
  v_marker public.ksef_submissions;
  v_num text;
  v_code text;
  v_dec_k text;
  v_dec_choice text;
  v_dec_via text;
  v_dec_reason text;
  v_choice_label text;
  v_env_check text;
  v_env_now text;
  v_closed integer;
BEGIN
  -- 0. Rola i argumenty.
  IF current_user <> 'service_role' AND current_user <> 'postgres' THEN
    RAISE EXCEPTION 'KSeF duplicate decision is server-managed' USING ERRCODE = '42501';
  END IF;
  IF p_invoice_id IS NULL OR p_tenant_id IS NULL OR p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'KSeF duplicate decision requires an invoice, a tenant and an actor'
      USING ERRCODE = '22023';
  END IF;
  IF p_choice IS NULL OR p_choice NOT IN ('same_sale', 'other_sale') THEN
    RAISE EXCEPTION 'KSeF duplicate decision choice must be same_sale or other_sale'
      USING ERRCODE = '22023';
  END IF;
  IF p_via IS NULL OR p_via NOT IN ('client', 'operator') THEN
    RAISE EXCEPTION 'KSeF duplicate decision via must be client or operator'
      USING ERRCODE = '22023';
  END IF;
  IF p_original_ksef_number IS NULL OR btrim(p_original_ksef_number) = '' THEN
    RAISE EXCEPTION 'KSeF duplicate decision requires the original KSeF number'
      USING ERRCODE = '22023';
  END IF;
  IF p_original_sha256 IS NULL OR p_original_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'KSeF duplicate decision requires a lowercase hex SHA-256 of the original'
      USING ERRCODE = '22023';
  END IF;
  IF p_env IS NULL OR p_env NOT IN ('test', 'demo', 'production') THEN
    RAISE EXCEPTION 'KSeF duplicate decision environment must be test, demo or production'
      USING ERRCODE = '22023';
  END IF;
  IF p_note IS NOT NULL AND length(p_note) > 1000 THEN
    RAISE EXCEPTION 'KSeF duplicate decision note is longer than 1000 characters'
      USING ERRCODE = '22023';
  END IF;
  IF p_via = 'operator' AND length(btrim(COALESCE(p_note, ''))) < 10 THEN
    RAISE EXCEPTION 'Zapisując decyzję klienta, opisz w notatce kanał, datę i osobę (co najmniej 10 znaków).' USING ERRCODE = '22023';
  END IF;
  IF p_via = 'client' AND NOT EXISTS (
    SELECT 1 FROM public.memberships m
     WHERE m.organization_id = p_tenant_id
       AND m.user_id = p_actor_user_id
       AND m.role IN ('owner', 'admin')
       AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Decyzję w sprawie dokumentu, którego numer jest zajęty w KSeF, zapisuje właściciel albo administrator firmy.' USING ERRCODE = '42501';
  END IF;

  -- 1. Blokada i odczyt — ta sama kolejność co requeue/reset (00131), bez
  --    zakleszczenia z nimi.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('ksef_send:' || p_invoice_id::text));

  SELECT * INTO v_inv
    FROM public.invoices
   WHERE id = p_invoice_id
     AND tenant_id = p_tenant_id
     AND direction = 'outgoing'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Faktura nie należy do tej firmy' USING ERRCODE = 'P0002';
  END IF;
  v_num := COALESCE(v_inv.internal_number, '(bez numeru)');

  -- 2. Powtórzenie (ponowienie od zera, zgubiona odpowiedź): ta sama decyzja
  --    = already_decided bez zapisów i audytu; inna — ALREADY.
  SELECT s.original_ksef_number,
         s.original_check->'decision'->>'choice',
         s.original_check->'decision'->>'via',
         s.original_check->'decision'->>'reason'
    INTO v_dec_k, v_dec_choice, v_dec_via, v_dec_reason
    FROM public.ksef_submissions s
   WHERE s.invoice_id = p_invoice_id
     AND s.tenant_id = p_tenant_id
     AND s.status = 'number_taken'
     AND COALESCE(s.original_check ? 'decision', false)
   ORDER BY s.completed_at DESC NULLS LAST, s.id
   LIMIT 1;
  IF FOUND THEN
    IF v_dec_k IS NOT DISTINCT FROM p_original_ksef_number
       AND v_dec_choice IS NOT DISTINCT FROM p_choice THEN
      RETURN jsonb_build_object(
        'invoice_id', p_invoice_id,
        'internal_number', v_inv.internal_number,
        'original_ksef_number', v_dec_k,
        'choice', v_dec_choice,
        'via', v_dec_via,
        'reason', v_dec_reason,
        'already_decided', true,
        'submissions_closed', 0);
    END IF;
    v_choice_label := CASE v_dec_choice WHEN 'same_sale' THEN 'ta sama sprzedaż' ELSE 'inna sprzedaż' END;
    RAISE EXCEPTION 'Decyzja dla dokumentu % jest już zapisana („%”). Jeśli była błędna, napisz do nas: pomoc@faktflow.pl, podając numer dokumentu.', v_num, v_choice_label USING ERRCODE = 'P0001';
  END IF;

  -- 3. Próba w toku.
  IF v_inv.ksef_status IN ('queued', 'sending') THEN
    RAISE EXCEPTION 'Sprawdzamy dokument % w KSeF — odśwież stronę za kilka minut.', v_num USING ERRCODE = 'P0001';
  END IF;

  -- 4. Blokada decyzji. Najpierw blokujemy wpisy, które decyzja zamyka
  --    (intent/sent/duplicate), żeby blokada, wiązanie (5) i zapis (a)
  --    widziały te same wiersze; znacznik jak w blokadzie (7).
  PERFORM 1
     FROM public.ksef_submissions s
    WHERE s.invoice_id = p_invoice_id
      AND s.tenant_id = p_tenant_id
      AND s.status IN ('intent', 'sent', 'duplicate')
      FOR UPDATE;

  SELECT s.* INTO v_marker
    FROM public.ksef_submissions s
   WHERE s.invoice_id = p_invoice_id
     AND s.tenant_id = p_tenant_id
     AND s.status IN ('intent', 'sent')
     AND s.original_ksef_number IS NOT NULL
   ORDER BY s.attempted_at DESC NULLS LAST, s.id
   LIMIT 1;

  v_code := public.ksef_duplicate_decision_blocker(p_invoice_id, p_tenant_id);
  IF v_code IS NOT NULL THEN
    IF v_code = 'not-found' THEN
      RAISE EXCEPTION 'Faktura nie należy do tej firmy' USING ERRCODE = 'P0002';
    ELSIF v_code = 'not-pending' THEN
      RAISE EXCEPTION 'Dokument % nie czeka już na Twoją decyzję — odśwież stronę.', v_num USING ERRCODE = 'P0001';
    ELSIF v_code = 'in-ksef' THEN
      RAISE EXCEPTION 'Dokument % ma już numer KSeF — decyzja nie jest potrzebna. Odśwież stronę; jeśli komunikat wraca, napisz do nas: pomoc@faktflow.pl.', v_num USING ERRCODE = 'P0001';
    ELSIF v_code = 'kind' THEN
      RAISE EXCEPTION 'Dokument % to korekta, faktura zaliczkowa albo rozliczeniowa — tej decyzji nie zapiszesz jeszcze w FaktFlow. Nie wystawiaj go ponownie i napisz do nas: pomoc@faktflow.pl, podając numer dokumentu.', v_num USING ERRCODE = 'P0001';
    ELSIF v_code = 'billing' THEN
      RAISE EXCEPTION 'Dokument % to faktura abonamentu FaktFlow — decyzję zapisuje pomoc FaktFlow.', v_num USING ERRCODE = 'P0001';
    ELSIF v_code = 'offline' THEN
      RAISE EXCEPTION 'Dokument % był wystawiony w trybie offline i mógł już trafić do nabywcy — tej decyzji nie zapiszesz w FaktFlow. Nie wystawiaj go ponownie i napisz do nas: pomoc@faktflow.pl, podając numer dokumentu.', v_num USING ERRCODE = 'P0001';
    ELSIF v_code = 'no-marker' THEN
      RAISE EXCEPTION 'Dla dokumentu % nie mamy zapisanej odpowiedzi KSeF o fakturze z tym numerem — tej decyzji nie zapiszesz w FaktFlow. Nie wystawiaj go ponownie i napisz do nas: pomoc@faktflow.pl, podając numer dokumentu.', v_num USING ERRCODE = 'P0001';
    ELSIF v_code = 'conflicting-originals' THEN
      RAISE EXCEPTION 'W historii dokumentu % są odpowiedzi KSeF o dwóch różnych fakturach — tej decyzji nie zapiszesz w FaktFlow. Nie wystawiaj go ponownie i napisz do nas: pomoc@faktflow.pl, podając numer dokumentu.', v_num USING ERRCODE = 'P0001';
    ELSIF v_code = 'no-check' THEN
      RAISE EXCEPTION 'Dla dokumentu % nie mamy jeszcze danych faktury z KSeF — sprawdzimy ją ponownie automatycznie (zwykle w ciągu 2 dni). Nie wystawiaj go ponownie.', v_num USING ERRCODE = 'P0001';
    ELSIF v_code = 'reason' THEN
      RAISE EXCEPTION 'Dla dokumentu % ta decyzja nie jest dostępna w panelu. Nie wystawiaj go ponownie; szczegóły są na karcie faktury, a pytania: pomoc@faktflow.pl.', v_num USING ERRCODE = 'P0001';
    ELSIF v_code = 'known-stale' THEN
      RAISE EXCEPTION 'Dokument w FaktFlow, który ma albo miał numer KSeF %, nie zgadza się już z naszym zapisem — sprawdzimy fakturę w KSeF ponownie automatycznie (zwykle w ciągu 2 dni). Jeśli ten komunikat zostanie dłużej, napisz do nas: pomoc@faktflow.pl. Nie wystawiaj dokumentu % ponownie.', v_marker.original_ksef_number, v_num USING ERRCODE = 'P0001';
    ELSIF v_code = 'own-history' THEN
      RAISE EXCEPTION 'Faktura % w KSeF może być wcześniejszą wersją dokumentu % wysłaną z FaktFlow — tej decyzji nie zapiszesz w panelu. Nie wystawiaj go ponownie i napisz do nas: pomoc@faktflow.pl, podając numer dokumentu.', v_marker.original_ksef_number, v_num USING ERRCODE = 'P0001';
    ELSIF v_code = 'payments' THEN
      RAISE EXCEPTION 'Na dokumencie % są zapisane wpłaty — decyzji nie zapiszemy, dopóki wpłaty są przy tym dokumencie. W FaktFlow nie zmienisz ich sam: napisz do nas: pomoc@faktflow.pl, podając numer dokumentu — ustalimy, przy której fakturze je zapisać. Nie wystawiaj go ponownie.', v_num USING ERRCODE = 'P0001';
    ELSE
      -- Kod spoza listy = rozjazd tej funkcji z blokadą; technicznie, nie dla klienta.
      RAISE EXCEPTION 'Unknown KSeF duplicate decision blocker: %', v_code USING ERRCODE = 'XX000';
    END IF;
  END IF;

  -- 5. Wiązanie: decyzja dotyczy dokładnie danych, które klient widział.
  IF v_marker.original_ksef_number IS DISTINCT FROM p_original_ksef_number
     OR (v_marker.original_check->>'sha256') IS DISTINCT FROM p_original_sha256 THEN
    RAISE EXCEPTION 'Dane faktury w KSeF dla dokumentu % zmieniły się od otwarcia strony — odśwież stronę i zdecyduj jeszcze raz.', v_num USING ERRCODE = 'P0001';
  END IF;

  -- 6. Środowisko: dane oryginału sprawdzone w środowisku serwera.
  IF (v_marker.original_check->>'env') IS DISTINCT FROM p_env THEN
    v_env_check := CASE v_marker.original_check->>'env'
      WHEN 'test' THEN 'testowe'
      WHEN 'production' THEN 'produkcyjne'
      WHEN 'demo' THEN 'demo'
      ELSE 'nieznane'
    END;
    v_env_now := CASE p_env
      WHEN 'test' THEN 'testowe'
      WHEN 'production' THEN 'produkcyjne'
      WHEN 'demo' THEN 'demo'
      ELSE 'nieznane'
    END;
    RAISE EXCEPTION 'Dane faktury % sprawdziliśmy w środowisku KSeF „%”, a FaktFlow pracuje teraz w środowisku „%” — tej decyzji nie zapiszesz. Nie wystawiaj dokumentu % ponownie i napisz do nas: pomoc@faktflow.pl.', v_marker.original_ksef_number, v_env_check, v_env_now, v_num USING ERRCODE = 'P0001';
  END IF;

  -- (a) Wszystkie otwarte wpisy → number_taken; decyzja tylko na wpisach
  --     z danymi tego oryginału (znacznik). Bez aktora i notatki.
  UPDATE public.ksef_submissions s
     SET status = 'number_taken',
         error_code = 'NUMBER_TAKEN',
         completed_at = now(),
         error_message = left(format('Decyzja klienta%s: %s — numer %s zajęty w KSeF przez fakturę %s',
                                     CASE p_via WHEN 'operator' THEN ' (zapisał operator)' ELSE '' END,
                                     CASE p_choice WHEN 'same_sale' THEN 'ta sama sprzedaż' ELSE 'inna sprzedaż' END,
                                     v_num,
                                     p_original_ksef_number), 500),
         original_check = CASE
           WHEN s.original_ksef_number = p_original_ksef_number AND s.original_check IS NOT NULL
             THEN s.original_check || jsonb_build_object('decision', jsonb_build_object(
                    'choice', p_choice,
                    'via', p_via,
                    'at', now(),
                    'reason', s.original_check->>'reason',
                    'env', p_env))
           ELSE s.original_check
         END
   WHERE s.invoice_id = p_invoice_id
     AND s.tenant_id = p_tenant_id
     AND s.status IN ('intent', 'sent', 'duplicate');
  GET DIAGNOSTICS v_closed = ROW_COUNT;

  -- (b) Obrona: po zamknięciu wpisów i przy przejściu blokady dowodu kontaktu
  --     być nie może.
  IF public.ksef_has_contact_evidence(p_invoice_id, p_tenant_id) THEN
    RAISE EXCEPTION 'Dokument % mógł dotrzeć do KSeF w innej próbie — decyzji nie zapiszemy. Nie wystawiaj go ponownie i napisz do nas: pomoc@faktflow.pl.', v_num USING ERRCODE = 'P0001';
  END IF;

  -- (c) Powrót do szkicu w miejscu, nie PERFORM reset_ksef_send: tamten
  --     odmawia klasie reconcile (00131) i zapisałby fałszywe previous_code.
  --     Pola jak w reset_ksef_send; internal_number zostaje — szkic wycofany
  --     trzyma numer.
  UPDATE public.invoices
     SET ksef_status = 'draft',
         ksef_send_owner = NULL,
         submitted_to_ksef_at = NULL,
         xml_storage_path = NULL,
         xml_generated_at = NULL,
         last_attempt_at = NULL,
         submission_attempts = 0,
         last_error = NULL,
         last_error_code = NULL,
         last_error_field = NULL,
         last_error_suggestion = NULL
   WHERE id = p_invoice_id
     AND tenant_id = p_tenant_id;

  -- (d) Audyt decyzji (aktor i notatka tylko tutaj).
  PERFORM public.ksef_send_audit(p_tenant_id, p_invoice_id, p_actor_user_id, 'invoice.ksef_duplicate_decided',
    jsonb_build_object(
      'choice', p_choice,
      'via', p_via,
      'note', p_note,
      'env', p_env,
      'reason', v_marker.original_check->>'reason',
      'marker_submission_id', v_marker.id,
      'submissions_closed', v_closed,
      'original', jsonb_build_object(
        'ksef_number', v_marker.original_ksef_number,
        'session', v_marker.original_session_reference_number,
        'sha256', v_marker.original_check->>'sha256',
        'summary', v_marker.original_check->'summary',
        'acquired_at', v_marker.original_check->'acquiredAt',
        'archive_path', v_marker.original_check->'archivePath',
        'known_invoice', v_marker.original_check->'knownInvoice',
        'same_content', v_marker.original_check->'sameContentExceptHeader'),
      'retired', jsonb_build_object(
        'internal_number', v_inv.internal_number,
        'issue_date', v_inv.issue_date,
        'buyer_nip', v_inv.buyer_nip,
        'buyer_name', v_inv.buyer_data->>'name',
        'gross_total', v_inv.gross_total,
        'currency', v_inv.currency),
      'previous', jsonb_build_object(
        'status', v_inv.ksef_status,
        'code', v_inv.last_error_code,
        'error', v_inv.last_error,
        'attempts', v_inv.submission_attempts,
        'last_attempt_at', v_inv.last_attempt_at,
        'submitted_to_ksef_at', v_inv.submitted_to_ksef_at,
        'xml_storage_path', v_inv.xml_storage_path,
        'xml_generated_at', v_inv.xml_generated_at)
    ));

  -- (e) Audyt resetu w kształcie reset_ksef_send (raport dzienny liczy resety).
  PERFORM public.ksef_send_audit(p_tenant_id, p_invoice_id, p_actor_user_id, 'invoice.send_reset',
    jsonb_build_object(
      'previous_status', v_inv.ksef_status,
      'previous_code', v_inv.last_error_code,
      'previous_error', v_inv.last_error,
      'previous_attempts', v_inv.submission_attempts,
      'previous_last_attempt_at', v_inv.last_attempt_at,
      'previous_submitted_to_ksef_at', v_inv.submitted_to_ksef_at,
      'previous_xml_storage_path', v_inv.xml_storage_path,
      'previous_xml_generated_at', v_inv.xml_generated_at,
      'via', 'ksef_duplicate_decision'
    ));

  -- (f) Wynik.
  RETURN jsonb_build_object(
    'invoice_id', p_invoice_id,
    'internal_number', v_inv.internal_number,
    'original_ksef_number', v_marker.original_ksef_number,
    'choice', p_choice,
    'via', p_via,
    'reason', v_marker.original_check->>'reason',
    'already_decided', false,
    'submissions_closed', v_closed);
END;
$$;
REVOKE ALL ON FUNCTION public.decide_ksef_duplicate(uuid, uuid, uuid, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.decide_ksef_duplicate(uuid, uuid, uuid, text, text, text, text, text, text) TO service_role;
COMMENT ON FUNCTION public.decide_ksef_duplicate(uuid, uuid, uuid, text, text, text, text, text, text) IS
  'Decyzja klienta (albo operatora na jego prośbę) przy nierozstrzygniętym duplikacie 440 (00148): same_sale albo other_sale. Jedna transakcja: wpisy intent/sent/duplicate → number_taken z decision na znaczniku, faktura → szkic wycofany (numer zostaje), audyt invoice.ksef_duplicate_decided i invoice.send_reset. Powtórzenie tej samej decyzji = already_decided bez zapisów.';

-- ─────────────────────────────────────────────────────────────────
-- 4. Szkic wycofany: bez wysyłki, bez usunięcia, zmiany numeru i kierunku z sesji klienta
-- ─────────────────────────────────────────────────────────────────
-- Szkic wycofany = szkic z wpisem number_taken (decyzja klienta albo
-- automatyczny KSEF_NUMBER_TAKEN). Teksty = retiredDraftSendRefusal,
-- retiredDraftView().deleteRefusal, TRIGGER_RENUMBER i TRIGGER_DIRECTION
-- w TS (test RLS je porównuje). SECURITY INVOKER: sesja klienta widzi wpisy
-- swojej firmy (RLS 00002, SELECT 00027) — tej samej, której szkic usuwa
-- albo zmienia.
CREATE OR REPLACE FUNCTION public.guard_ksef_retired_draft()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_k text;
  v_choice text;
  v_num text;
  v_ref text;
  v_ref_acc text;
BEGIN
  -- 1. Serwis (service_role, postgres) usuwa, przenumerowuje i zmienia
  --    kierunek: operator za zgodą Bartosza, retencja, sprzątanie testów
  --    (wzór 00132). Wyzwalacz stanu nie ma wyjątku roli.
  IF TG_OP = 'DELETE' THEN
    IF current_user NOT IN ('authenticated', 'anon') THEN
      RETURN OLD;
    END IF;
  ELSIF TG_NAME = 'c_guard_ksef_retired_draft_number' THEN
    IF current_user NOT IN ('authenticated', 'anon') THEN
      RETURN NEW;
    END IF;
  END IF;

  -- 2. Wpis number_taken: najpierw z decyzją (NULL ? 'decision' = NULL, stąd
  --    COALESCE), potem z numerem oryginału (automatyczne zamknięcie obejmuje
  --    też wpisy bez znacznika), potem najnowszy. Osobne zapytanie funkcji
  --    VOLATILE ma świeżą migawkę: widzi decyzję zatwierdzoną, gdy UPDATE
  --    czekał na blokadę wiersza (EvalPlanQual).
  SELECT s.original_ksef_number, s.original_check->'decision'->>'choice'
    INTO v_k, v_choice
    FROM public.ksef_submissions s
   WHERE s.invoice_id = OLD.id
     AND s.tenant_id = OLD.tenant_id
     AND s.status = 'number_taken'
   ORDER BY COALESCE(s.original_check ? 'decision', false) DESC,
            (s.original_ksef_number IS NOT NULL) DESC,
            s.completed_at DESC NULLS LAST,
            s.id
   LIMIT 1;

  -- 3. Bez wpisu: zwykły szkic.
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  -- 4. Numer i odwołanie do oryginału (mianownik / biernik).
  v_num := COALESCE(OLD.internal_number, '(bez numeru)');
  v_ref := CASE WHEN v_k IS NULL THEN 'inna faktura Twojej firmy' ELSE 'faktura ' || v_k END;
  v_ref_acc := CASE WHEN v_k IS NULL THEN 'inną fakturę Twojej firmy' ELSE 'fakturę ' || v_k END;

  -- 5. Usunięcie z sesji klienta (zwykła faktura i zaliczka — WHEN wyzwalacza).
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Wycofanego dokumentu % nie usuniesz: zajmuje numer, który w KSeF ma już %, i zostaje w FaktFlow, żeby ten numer nie został podpowiedziany ponownie. Jeśli musisz go usunąć, napisz do nas: pomoc@faktflow.pl.', v_num, v_ref USING ERRCODE = 'P0001';
  END IF;

  -- 6. Zmiana numeru albo kierunku z sesji klienta (każdy rodzaj, 07.10 (11)).
  --    Kierunek: faktura zakupowa wypada z indeksu unikalnego numerów sprzedaży
  --    (00120), więc numer byłby znów wolny dla nowej faktury sprzedaży.
  --    Zmiana kierunku i numeru naraz dostaje tekst o kierunku.
  IF TG_NAME = 'c_guard_ksef_retired_draft_number' THEN
    IF NEW.direction IS DISTINCT FROM OLD.direction THEN
      RAISE EXCEPTION 'Wycofanego dokumentu % nie zmienisz na fakturę zakupową: zajmuje numer, który w KSeF ma już %, i zostaje w FaktFlow jako faktura sprzedaży, żeby tego numeru nie dostała inna faktura sprzedaży.', v_num, v_ref USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION 'Numeru wycofanego dokumentu % nie zmienisz: ten numer ma w KSeF już %, a dokument zostaje z nim w FaktFlow, żeby numer nie został podpowiedziany ponownie. Inną sprzedaż wystaw jako nową fakturę z nowym numerem.', v_num, v_ref USING ERRCODE = 'P0001';
  END IF;

  -- 7. Wyjście ze stanu draft (każda rola). Decyzja zawsze stoi na wpisie
  --    z K; wpis z decyzją bez K (uszkodzone dane) dostaje tekst automatu,
  --    jak w TS (retiredDraftSendRefusal), a nie „<NULL>” w komunikacie.
  IF v_choice = 'same_sale' AND v_k IS NOT NULL THEN
    RAISE EXCEPTION 'Dokument % jest wycofany: to ta sama sprzedaż co faktura % w KSeF. Tego dokumentu nie wyślesz do KSeF.', v_num, v_k USING ERRCODE = 'P0001';
  ELSIF v_choice = 'other_sale' AND v_k IS NOT NULL THEN
    RAISE EXCEPTION 'Dokument % jest wycofany: numer jest zajęty w KSeF przez fakturę %. Tego dokumentu nie wyślesz do KSeF — tę sprzedaż wystaw jako nową fakturę z nowym numerem.', v_num, v_k USING ERRCODE = 'P0001';
  END IF;
  RAISE EXCEPTION 'Numer % jest zajęty w KSeF przez % wystawioną poza FaktFlow — tego dokumentu nie wyślesz do KSeF (KSeF odrzuciłby go jako duplikat). Jeśli to inna sprzedaż, wystaw ją jako nową fakturę z nowym numerem.', v_num, v_ref_acc USING ERRCODE = 'P0001';
END;
$$;
REVOKE ALL ON FUNCTION public.guard_ksef_retired_draft() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.guard_ksef_retired_draft() IS
  'Szkic wycofany (wpis ksef_submissions number_taken, 00148): nie wychodzi ze stanu draft (każda rola), a sesja klienta nie usuwa szkicu zwykłej faktury ani zaliczki (niezależnie od kierunku) i nie zmienia numeru ani kierunku szkicu żadnego rodzaju. Serwis usuwa, przenumerowuje i zmienia kierunek za zgodą Bartosza.';

-- Wyjście ze stanu draft: claim_ksef_send, enqueue_ksef_send (P0001 cofa
-- zlecenie pg-boss w tej samej transakcji), zapis porażki, zapis akceptacji,
-- offline_queued. Prefiks c_ — po strażnikach a_/b_, przed guard_*/trg_*.
DROP TRIGGER IF EXISTS c_guard_ksef_retired_draft ON public.invoices;
CREATE TRIGGER c_guard_ksef_retired_draft
  BEFORE UPDATE OF ksef_status ON public.invoices FOR EACH ROW
  WHEN (OLD.ksef_status = 'draft' AND NEW.ksef_status IS DISTINCT FROM 'draft')
  EXECUTE FUNCTION public.guard_ksef_retired_draft();

-- Bezpośredni DELETE z PostgREST: RLS pozwala usunąć każdy szkic (00002),
-- a szkic po resecie nie ma pól wysyłki (00132 przepuszcza). Usunięcie
-- zwolniłoby numer i skasowało ślad decyzji (ON DELETE CASCADE, 00001).
-- Kierunku nie ma w WHEN: wpisy number_taken powstają tylko przy fakturach
-- wychodzących, więc rozstrzyga zapytanie funkcji (krok 2). Warunek
-- OLD.direction = 'outgoing' klient obchodziłby, zmieniając najpierw
-- kierunek na 'incoming' (wyzwalacz numeru niżej odmawia tego, ale szkic
-- przestawiony wcześniej przez serwis też ma zostać nieusuwalny).
DROP TRIGGER IF EXISTS c_guard_ksef_retired_draft_delete ON public.invoices;
CREATE TRIGGER c_guard_ksef_retired_draft_delete
  BEFORE DELETE ON public.invoices FOR EACH ROW
  WHEN (OLD.ksef_status = 'draft'
        AND OLD.invoice_kind IN ('regular', 'advance'))          -- 07.10 (9): KOR i ROZ zostają usuwalne
  EXECUTE FUNCTION public.guard_ksef_retired_draft();

-- PATCH internal_number albo direction z PostgREST (RLS 00002 pozwala, 00132
-- nie zamraża szkicu bez pól wysyłki, 00073 zamraża kierunek tylko faktury
-- przyjętej): zmieniony numer wróciłby do podpowiedzi, a faktura zakupowa
-- wypada z indeksu unikalnego numerów sprzedaży (00120). Nazwa wyzwalacza
-- zostaje — funkcja rozgałęzia się po TG_NAME.
DROP TRIGGER IF EXISTS c_guard_ksef_retired_draft_number ON public.invoices;
CREATE TRIGGER c_guard_ksef_retired_draft_number
  BEFORE UPDATE OF internal_number, direction ON public.invoices FOR EACH ROW
  WHEN (OLD.ksef_status = 'draft'
        AND (NEW.internal_number IS DISTINCT FROM OLD.internal_number
             OR NEW.direction IS DISTINCT FROM OLD.direction))
  EXECUTE FUNCTION public.guard_ksef_retired_draft();          -- 07.10 (11), rewizja PR B #0

-- ─────────────────────────────────────────────────────────────────
-- 5. Strażnik: I5 bez faktur czekających na klienta + I5D (00136 + 00148)
-- ─────────────────────────────────────────────────────────────────
-- Ciało z 00136 bez zmian poza jedną linią w I5 i blokiem I5D przed I9.
-- Blokada (INVOKER) działa tu jako właściciel (DEFINER) i czyta payments.
-- Cron bierze tylko I5 — faktur czekających na klienta nie uzgadnia.
CREATE OR REPLACE FUNCTION public.ksef_lifecycle_violations()
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

  -- I3: accepted bez numeru / środowiska / pliku XML albo bez wiersza UPO.
  RETURN QUERY
    SELECT 'I3'::text, i.id, i.tenant_id,
           jsonb_build_object(
             'ksef_number', i.ksef_number IS NOT NULL,
             'ksef_environment', i.ksef_environment,
             'xml_storage_path', i.xml_storage_path IS NOT NULL,
             'upo', EXISTS (SELECT 1 FROM public.upo_receipts u WHERE u.invoice_id = i.id)
           )
      FROM public.invoices i
     WHERE i.direction = 'outgoing'
       AND i.ksef_status = 'accepted'
       AND (
         i.ksef_number IS NULL
         OR i.ksef_environment IS NULL
         OR i.xml_storage_path IS NULL
         OR NOT EXISTS (SELECT 1 FROM public.upo_receipts u WHERE u.invoice_id = i.id)
       );

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
  RETURN QUERY
    SELECT 'I5'::text, s.invoice_id, s.tenant_id,
           jsonb_build_object('attempted_at', s.attempted_at, 'session', s.session_reference_number,
                              'ksef_status', i.ksef_status, 'submission_status', s.status)
      FROM public.ksef_submissions s
      JOIN public.invoices i ON i.id = s.invoice_id
     WHERE s.status IN ('sent', 'intent')
       AND s.attempted_at < now() - interval '48 hours'
       AND i.ksef_status <> 'sending'
       AND public.ksef_duplicate_decision_blocker(s.invoice_id, s.tenant_id) IS NOT NULL;  -- 00148: czeka na klienta = I5D

  -- I5D (00148): faktura czeka na decyzję klienta — nierozstrzygnięty 440 z kompletnymi
  -- danymi oryginału (blokada decyzji = NULL). Osobno od I5: cron jej nie uzgadnia,
  -- alarm krytyczny jej nie liczy (chyba że środowisko się nie zgadza), raport — osobny wiersz.
  RETURN QUERY
    SELECT 'I5D'::text, i.id, i.tenant_id,
           jsonb_build_object(
             'original_ksef_number', m.original_ksef_number,
             'reason', m.original_check->>'reason',
             'env', m.original_check->>'env',
             'checked_at', m.original_check->>'checkedAt',
             'attempted_at', m.attempted_at,
             'last_attempt_at', i.last_attempt_at)
      FROM public.invoices i
      CROSS JOIN LATERAL (
        SELECT s.original_ksef_number, s.original_check, s.attempted_at
          FROM public.ksef_submissions s
         WHERE s.invoice_id = i.id AND s.tenant_id = i.tenant_id
           AND s.status IN ('intent', 'sent') AND s.original_ksef_number IS NOT NULL
         ORDER BY s.attempted_at DESC NULLS LAST, s.id
         LIMIT 1) m
     WHERE i.direction = 'outgoing'
       AND i.ksef_status = 'failed'
       AND i.last_error_code = 'KSEF_DUPLICATE_RECONCILE'
       AND public.ksef_duplicate_decision_blocker(i.id, i.tenant_id) IS NULL;

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
REVOKE ALL ON FUNCTION public.ksef_lifecycle_violations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ksef_lifecycle_violations() TO service_role;
COMMENT ON FUNCTION public.ksef_lifecycle_violations() IS
  'Naruszenia inwariantów cyklu życia faktury I1–I5, I9 (docs/architecture/cykl-zycia-faktury-ksef.md) oraz I5D — faktura czeka na decyzję klienta przy nierozstrzygniętym 440 (00148; nie alarm krytyczny, w raporcie osobno; I5 jej nie zawiera). I6–I8 realizuje cron i indeks unikalny numeru.';

-- ─────────────────────────────────────────────────────────────────
-- 6. Opis original_check: klucz decision (00144 + 00148)
-- ─────────────────────────────────────────────────────────────────
COMMENT ON COLUMN public.ksef_submissions.original_check IS
  'D-A4-1b-3 (00144): wynik weryfikacji duplikatu 440, którego automat nie rozstrzygnął — {v, env, checkedAt, reason (known-number | download-refused | download-pending | storage-pending | archive-pending | faktflow-original | same-content-other-program | no-own-file | archive-conflict), sha256, archivePath, sizeBytes, summary {systemInfo, number, issueDate, buyerNip, buyerName, gross, currency}, sameContentExceptHeader, ownHistory, acquiredAt, httpStatus, knownInvoice, recheck}. Tylko na otwartym wpisie ze znacznikiem 440; pisze serwer. Ponowne sprawdzenie, które nie pobrało oryginału, nie kasuje danych z udanego — zapisuje się w recheck. decision {choice, via, at, reason, env} — zapisuje wyłącznie decide_ksef_duplicate (00148), raz, gdy wpis staje się number_taken; obecność klucza = dokument wycofany decyzją klienta. Od 00148 powód known-number też niesie dane oryginału (sha256, summary, archivePath) i knownInvoice.';

-- ─────────────────────────────────────────────────────────────────
-- 7. Katalog: KSEF_NUMBER_TAKEN bez „usuń go” (07.10 (3); precedens 00143)
-- ─────────────────────────────────────────────────────────────────
-- Jeden wiersz referencyjny (00142), nie dane klientów. Przed uruchomieniem:
--   SELECT count(*) FROM public.ksef_error_codes WHERE code = 'KSEF_NUMBER_TAKEN';  -- 1
-- Zwykłej faktury i zaliczki z wpisem number_taken nie da się usunąć, KOR i ROZ
-- tak (07.10 (9)) — ich własne teksty mówią to w aplikacji. Tekst stały, więc
-- powtórne wykonanie niczego nie zmienia.
UPDATE public.ksef_error_codes
   SET client_message = 'W KSeF jest już faktura Twojej firmy o tym numerze, wystawiona w innym programie. Tego dokumentu nie wyślesz do KSeF. Jeśli to ta sama sprzedaż — nie wystawiaj jej ponownie. Jeśli inna — wystaw ją jako nową fakturę z nowym numerem.'
 WHERE code = 'KSEF_NUMBER_TAKEN';

COMMIT;
