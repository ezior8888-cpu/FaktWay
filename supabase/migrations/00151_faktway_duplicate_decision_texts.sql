-- 00151_faktway_duplicate_decision_texts.sql
--
-- Zmiana marki FaktFlow → FaktWay (17.10.2026, plan docs/rebrand/FAKTWAY.md):
-- komunikaty, które baza zwraca klientowi przy decyzji o duplikacie KSeF
-- (RAISE z 00148), mówią „FaktWay” i podają pomoc@faktway.pl zamiast
-- „FaktFlow” i adresu pomocy w dawnej domenie. Lustro w TS:
-- DUPLICATE_DECISION_SQL_TEXTS w lib/ksef/duplicate-decision.ts (testy RLS
-- porównują je z bazą słowo w słowo).
--
-- CREATE OR REPLACE dwóch funkcji z 00148, w których stoją te teksty:
--   decide_ksef_duplicate(...) — odmowy ALREADY, in-ksef, kind, billing,
--     offline, no-marker, conflicting-originals, reason, known-stale,
--     own-history, payments, ENV, EVIDENCE;
--   guard_ksef_retired_draft() — funkcja trzech wyzwalaczy szkicu
--     wycofanego: TRIGGER_AUTO, TRIGGER_DELETE, TRIGGER_RENUMBER,
--     TRIGGER_DIRECTION.
-- Ciała są kopią z 00148 znak w znak poza literałami z marką (nazwa
-- produktu i adres pomocy). Logika, kolejność kroków, kody błędów
-- i nagłówki funkcji (parametry, SECURITY, search_path) bez zmian — pilnuje
-- tego strażnik U16h w tests/unit/ksef-decyzja-duplikatu-migracja.test.ts.
-- Wyzwalaczy nie tworzymy ponownie: wołają funkcję po nazwie, a CREATE OR
-- REPLACE podmienia jej ciało. ksef_duplicate_check_allows,
-- ksef_duplicate_decision_blocker i ksef_lifecycle_violations nie mają marki
-- w tekstach — zostają z 00148. CREATE OR REPLACE zachowuje COMMENT ON
-- i uprawnienia; REVOKE i GRANT powtarzamy jak w 00148.
--
-- KIEDY: w dniu przełączenia marki, razem z wdrożeniem #277 (FaktWay
-- w aplikacji): najpierw ta migracja, potem wdrożenie — jak każda
-- addytywna. Odwrotna kolejność też niczego nie psuje: kod porównuje
-- komunikat z bazy z lustrem tylko dla NOTE (app/admin/ksef/actions.ts),
-- a ten tekst się nie zmienia. W oknie migracja→wdrożenie klient może
-- zobaczyć obie nazwy, bo część odmów stary kod liczy sam z lustra TS.
-- Bez DROP, bez DML, bez zmian danych; powtórne wykonanie niczego nie
-- zmienia. Skrzynka pomocy w dawnej domenie dalej odbiera pocztę
-- (ops/poczta/worker.mjs) — dla komunikatów pokazanych wcześniej.
--
-- Wycofanie: ponowne wykonanie definicji obu funkcji z 00148 (sekcje 3 i 4,
-- bez wyzwalaczy).
--
-- Przed uruchomieniem (sesja lokalna, AGENTS.md „Wgrywanie migracji”):
--   SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 3;
--     → jest 00148 i 00150, nie ma 00151;
--   SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace
--      AND proname IN ('decide_ksef_duplicate', 'guard_ksef_retired_draft')
--      AND prosrc ILIKE '%faktflow%';
--     → 2 wiersze przed, 0 po (weryfikacja po wgraniu).

BEGIN;

-- ─────────────────────────────────────────────────────────────────
-- 1. Decyzja klienta przy nierozstrzygniętym 440 (00148, sekcja 3)
-- ─────────────────────────────────────────────────────────────────
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
    RAISE EXCEPTION 'Decyzja dla dokumentu % jest już zapisana („%”). Jeśli była błędna, napisz do nas: pomoc@faktway.pl, podając numer dokumentu.', v_num, v_choice_label USING ERRCODE = 'P0001';
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
      RAISE EXCEPTION 'Dokument % ma już numer KSeF — decyzja nie jest potrzebna. Odśwież stronę; jeśli komunikat wraca, napisz do nas: pomoc@faktway.pl.', v_num USING ERRCODE = 'P0001';
    ELSIF v_code = 'kind' THEN
      RAISE EXCEPTION 'Dokument % to korekta, faktura zaliczkowa albo rozliczeniowa — tej decyzji nie zapiszesz jeszcze w FaktWay. Nie wystawiaj go ponownie i napisz do nas: pomoc@faktway.pl, podając numer dokumentu.', v_num USING ERRCODE = 'P0001';
    ELSIF v_code = 'billing' THEN
      RAISE EXCEPTION 'Dokument % to faktura abonamentu FaktWay — decyzję zapisuje pomoc FaktWay.', v_num USING ERRCODE = 'P0001';
    ELSIF v_code = 'offline' THEN
      RAISE EXCEPTION 'Dokument % był wystawiony w trybie offline i mógł już trafić do nabywcy — tej decyzji nie zapiszesz w FaktWay. Nie wystawiaj go ponownie i napisz do nas: pomoc@faktway.pl, podając numer dokumentu.', v_num USING ERRCODE = 'P0001';
    ELSIF v_code = 'no-marker' THEN
      RAISE EXCEPTION 'Dla dokumentu % nie mamy zapisanej odpowiedzi KSeF o fakturze z tym numerem — tej decyzji nie zapiszesz w FaktWay. Nie wystawiaj go ponownie i napisz do nas: pomoc@faktway.pl, podając numer dokumentu.', v_num USING ERRCODE = 'P0001';
    ELSIF v_code = 'conflicting-originals' THEN
      RAISE EXCEPTION 'W historii dokumentu % są odpowiedzi KSeF o dwóch różnych fakturach — tej decyzji nie zapiszesz w FaktWay. Nie wystawiaj go ponownie i napisz do nas: pomoc@faktway.pl, podając numer dokumentu.', v_num USING ERRCODE = 'P0001';
    ELSIF v_code = 'no-check' THEN
      RAISE EXCEPTION 'Dla dokumentu % nie mamy jeszcze danych faktury z KSeF — sprawdzimy ją ponownie automatycznie (zwykle w ciągu 2 dni). Nie wystawiaj go ponownie.', v_num USING ERRCODE = 'P0001';
    ELSIF v_code = 'reason' THEN
      RAISE EXCEPTION 'Dla dokumentu % ta decyzja nie jest dostępna w panelu. Nie wystawiaj go ponownie; szczegóły są na karcie faktury, a pytania: pomoc@faktway.pl.', v_num USING ERRCODE = 'P0001';
    ELSIF v_code = 'known-stale' THEN
      RAISE EXCEPTION 'Dokument w FaktWay, który ma albo miał numer KSeF %, nie zgadza się już z naszym zapisem — sprawdzimy fakturę w KSeF ponownie automatycznie (zwykle w ciągu 2 dni). Jeśli ten komunikat zostanie dłużej, napisz do nas: pomoc@faktway.pl. Nie wystawiaj dokumentu % ponownie.', v_marker.original_ksef_number, v_num USING ERRCODE = 'P0001';
    ELSIF v_code = 'own-history' THEN
      RAISE EXCEPTION 'Faktura % w KSeF może być wcześniejszą wersją dokumentu % wysłaną z FaktWay — tej decyzji nie zapiszesz w panelu. Nie wystawiaj go ponownie i napisz do nas: pomoc@faktway.pl, podając numer dokumentu.', v_marker.original_ksef_number, v_num USING ERRCODE = 'P0001';
    ELSIF v_code = 'payments' THEN
      RAISE EXCEPTION 'Na dokumencie % są zapisane wpłaty — decyzji nie zapiszemy, dopóki wpłaty są przy tym dokumencie. W FaktWay nie zmienisz ich sam: napisz do nas: pomoc@faktway.pl, podając numer dokumentu — ustalimy, przy której fakturze je zapisać. Nie wystawiaj go ponownie.', v_num USING ERRCODE = 'P0001';
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
    RAISE EXCEPTION 'Dane faktury % sprawdziliśmy w środowisku KSeF „%”, a FaktWay pracuje teraz w środowisku „%” — tej decyzji nie zapiszesz. Nie wystawiaj dokumentu % ponownie i napisz do nas: pomoc@faktway.pl.', v_marker.original_ksef_number, v_env_check, v_env_now, v_num USING ERRCODE = 'P0001';
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
    RAISE EXCEPTION 'Dokument % mógł dotrzeć do KSeF w innej próbie — decyzji nie zapiszemy. Nie wystawiaj go ponownie i napisz do nas: pomoc@faktway.pl.', v_num USING ERRCODE = 'P0001';
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

-- ─────────────────────────────────────────────────────────────────
-- 2. Szkic wycofany — funkcja trzech wyzwalaczy c_guard_ksef_retired_draft* (00148, sekcja 4)
-- ─────────────────────────────────────────────────────────────────
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
    RAISE EXCEPTION 'Wycofanego dokumentu % nie usuniesz: zajmuje numer, który w KSeF ma już %, i zostaje w FaktWay, żeby ten numer nie został podpowiedziany ponownie. Jeśli musisz go usunąć, napisz do nas: pomoc@faktway.pl.', v_num, v_ref USING ERRCODE = 'P0001';
  END IF;

  -- 6. Zmiana numeru albo kierunku z sesji klienta (każdy rodzaj, 07.10 (11)).
  --    Kierunek: faktura zakupowa wypada z indeksu unikalnego numerów sprzedaży
  --    (00120), więc numer byłby znów wolny dla nowej faktury sprzedaży.
  --    Zmiana kierunku i numeru naraz dostaje tekst o kierunku.
  IF TG_NAME = 'c_guard_ksef_retired_draft_number' THEN
    IF NEW.direction IS DISTINCT FROM OLD.direction THEN
      RAISE EXCEPTION 'Wycofanego dokumentu % nie zmienisz na fakturę zakupową: zajmuje numer, który w KSeF ma już %, i zostaje w FaktWay jako faktura sprzedaży, żeby tego numeru nie dostała inna faktura sprzedaży.', v_num, v_ref USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION 'Numeru wycofanego dokumentu % nie zmienisz: ten numer ma w KSeF już %, a dokument zostaje z nim w FaktWay, żeby numer nie został podpowiedziany ponownie. Inną sprzedaż wystaw jako nową fakturę z nowym numerem.', v_num, v_ref USING ERRCODE = 'P0001';
  END IF;

  -- 7. Wyjście ze stanu draft (każda rola). Decyzja zawsze stoi na wpisie
  --    z K; wpis z decyzją bez K (uszkodzone dane) dostaje tekst automatu,
  --    jak w TS (retiredDraftSendRefusal), a nie „<NULL>” w komunikacie.
  IF v_choice = 'same_sale' AND v_k IS NOT NULL THEN
    RAISE EXCEPTION 'Dokument % jest wycofany: to ta sama sprzedaż co faktura % w KSeF. Tego dokumentu nie wyślesz do KSeF.', v_num, v_k USING ERRCODE = 'P0001';
  ELSIF v_choice = 'other_sale' AND v_k IS NOT NULL THEN
    RAISE EXCEPTION 'Dokument % jest wycofany: numer jest zajęty w KSeF przez fakturę %. Tego dokumentu nie wyślesz do KSeF — tę sprzedaż wystaw jako nową fakturę z nowym numerem.', v_num, v_k USING ERRCODE = 'P0001';
  END IF;
  RAISE EXCEPTION 'Numer % jest zajęty w KSeF przez % wystawioną poza FaktWay — tego dokumentu nie wyślesz do KSeF (KSeF odrzuciłby go jako duplikat). Jeśli to inna sprzedaż, wystaw ją jako nową fakturę z nowym numerem.', v_num, v_ref_acc USING ERRCODE = 'P0001';
END;
$$;
REVOKE ALL ON FUNCTION public.guard_ksef_retired_draft() FROM PUBLIC, anon, authenticated;

COMMIT;
