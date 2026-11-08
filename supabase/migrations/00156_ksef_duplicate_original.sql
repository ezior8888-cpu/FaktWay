-- 00156_ksef_duplicate_original.sql
--
-- D-A4-1b-3 PR C (plan „zero zgubionych faktur”): oryginał z oznaczeniem
-- naszego programu przy nierozstrzygniętym 440 (powód `faktflow-original`;
-- identyfikator zostaje po zmianie marki), decyzje Bartosza 04.10, 07.10
-- i 08.10.2026 (C1–C8). Brama pochodzenia liczona w runnerze
-- (`original_check.importGate`) wybiera ofertę: zapis oryginału przez klienta
-- (para albo jeden przycisk), przegląd operatora albo — po oddaniu przez
-- operatora — decyzja jak przy innym programie. Zapis oryginału w jednej
-- transakcji: wycofanie dokumentu (jak 00148), numer przechodzi z dokumentu
-- na oryginał, oryginał jako przyjęta faktura sprzedaży (origin ksef_import)
-- z pozycjami, xml_documents, sesją oryginału i wierszem upo_receipts.
--
-- NUMER 00156, nie 00149. PR C miał rezerwację 00149 (szkic #248), ale zanim
-- wszedł, 00151 (marka FaktWay) przepisała decide_ksef_duplicate
-- i guard_ksef_retired_draft, a 00155 (synchronizacja historii) —
-- ksef_lifecycle_violations (I3 przez ksef_upo_expected). Pod numerem 00149
-- świeża baza (pliki w kolejności numerów) wgrałaby PR C PRZED nimi, a 00151
-- i 00155 cofnęłyby po cichu opakowanie decyzji, krok 3b wyzwalacza oraz I5R
-- i I3K. Reguła 05.10: migracja przenoszona bierze kolejny wolny numer
-- (rejestr: docs/koordynacja/CLAUDE-DO-CODEXA.md; 00149 zostaje nieużyty).
-- Ciała napisane na tym, co obowiązuje dziś:
--   - decide_ksef_duplicate (9 argumentów) i tryb retire w core — zachowanie
--     i teksty z 00151 (FaktWay, pomoc@faktway.pl), INV-14;
--   - guard_ksef_retired_draft — ciało z 00151 + krok 3b (teksty *_IMPORTED);
--   - ksef_lifecycle_violations — ciało z 00155 (I3 przez ksef_upo_expected,
--     strażnik tests/unit/ksef-cykl-zycia-wersje.test.ts) + I5 bez przeglądu
--     pliku, I5D i I5R jednym zapytaniem, I3K;
--   - ksef_duplicate_check_allows i ksef_duplicate_decision_blocker — od 00148
--     nikt ich nie zmieniał (00151 i 00155 ich nie dotykają).
-- Nowe teksty dla klienta (spec v3 6.3) mówią „FaktWay” i pomoc@faktway.pl;
-- lustro: DUPLICATE_DECISION_SQL_TEXTS (lib/ksef/duplicate-decision.ts),
-- strażnik U16e-00156 (tests/unit/zapis-oryginalu-migracja.test.ts).
--
--  1. ksef_duplicate_check_allows — + faktflow-original (CREATE OR REPLACE).
--  2. ksef_duplicate_own_history — predykat 00148 krok 12 jako funkcja.
--  3. ksef_duplicate_gate_ok — poprawny kształt importGate (wspólny dla 4, 6, 12).
--  4. ksef_duplicate_original_offer — oferta z importGate i własnej historii.
--  5. ksef_duplicate_cross_tenant — K albo numer w innej firmie (jedyne miejsce reguły).
--  6. ksef_duplicate_decision_blocker — + known-now, cross-tenant,
--     recheck-needed, provenance-review; own-history nie dla faktflow-original
--     (CREATE OR REPLACE).
--  7. ksef_duplicate_decision_blocker_for_session — blokada dla sesji klienta.
--  8. ksef_original_import_mismatch — kontrola projekcji oryginału.
--  9. ksef_duplicate_decide_core — ciało decyzji (tryby retire/import/no-import).
-- 10. decide_ksef_duplicate (te same 9 argumentów) — opakowanie core('retire').
-- 11. decide_ksef_duplicate_original — opakowanie core('import'|'no-import').
-- 12. release_ksef_original_review — operator oddaje decyzję klientowi.
-- 13. flag_ksef_original_recheck — trwały znacznik „sprawdź ponownie”.
-- 14. guard_ksef_retired_draft — teksty szkicu wycofanego po zapisie oryginału.
-- 15. ksef_lifecycle_violations — I5 bez przeglądu, I5R, I3K (CREATE OR REPLACE).
-- 16. COMMENT original_check (importGate, recheckNeeded, decision.mode…).
--
-- PRZED wdrożeniem kodu: CREATE OR REPLACE i nowe funkcje; bez DML na danych,
-- bez DROP. Stary kod: decyzji dla faktflow-original nie woła (TS odmawia
-- przed RPC — allows TS bez faktflow-original); decide_ksef_duplicate dla
-- no-own-file/known-number działa jak w 00151 (INV-14: te same kroki, kody
-- i teksty). Okno migracja→wdrożenie: stary runner zapisuje znacznik
-- faktflow-original bez importGate → blokada recheck-needed → I5 (stary cron
-- po 48 h robi „Tylko uzgodnij”, a nowy runner zapisze bramę); stary
-- notify-user idzie ścieżką ogólną. Okno worker→web: nowy worker może wysłać
-- e-mail „zapisz fakturę z KSeF”, a stary panel jeszcze odmawia („decyzji
-- w panelu nie ma”) — przy 0 znacznikach bez skutku, okno to minuty.
-- Produkcja 08.10: 0 takich znaczników (sprawdź zapytaniem niżej).
-- Wdrożenie: worker (id=2), potem web (id=1).
--
-- Wycofanie (decyzja Bartosza): NAJPIERW zapisz wynik zapytania I3K
-- (ksef_lifecycle_violations() WHERE invariant = 'I3K' — faktury z KSeF bez
-- sesji UPO albo daty; po wycofaniu nic ich nie pokaże) w runbooku. Potem,
-- w jednej transakcji, CREATE OR REPLACE:
--   - decide_ksef_duplicate — ciałem z 00151 (sekcja 1; teksty FaktWay);
--   - ksef_lifecycle_violations — ciałem z 00155 (sekcja 8; I3 przez
--     ksef_upo_expected — bez niego I3 pokaże całą historię z KSeF);
--   - ksef_duplicate_check_allows i ksef_duplicate_decision_blocker — ciałami
--     z 00148;
-- i dopiero po nich (ciała SQL/plpgsql nie mają zależności w katalogu, więc
-- DROP przeszedłby także przed nimi i zostawił opakowanie bez core) DROP
-- FUNCTION decide_ksef_duplicate_original, release_ksef_original_review,
-- flag_ksef_original_recheck, ksef_duplicate_decide_core,
-- ksef_original_import_mismatch, ksef_duplicate_decision_blocker_for_session,
-- ksef_duplicate_original_offer, ksef_duplicate_cross_tenant,
-- ksef_duplicate_gate_ok, ksef_duplicate_own_history.
-- guard_ksef_retired_draft ZOSTAJE z 00156 (decyzja Bartosza, spec v3 4.1):
-- bez decyzji z zapisem oryginału jej teksty i kolejność są identyczne
-- z 00151, a ciało z 00151 pokazałoby przy szkicu bez numeru „zajmuje numer,
-- który w KSeF ma już…”, co byłoby fałszem. Tylko gdy żadnej decyzji z zapisem
-- nie było (SELECT count(*) FROM public.ksef_submissions
-- WHERE original_check->'decision' ? 'importedInvoiceId' → 0), można ją cofnąć
-- ciałem z 00151 (sekcja 2). Faktury zapisane z KSeF zostają (są poprawnym
-- zapisem wystawionych faktur); szkice wycofane bez numeru zostają bez numeru.
--
-- Przed uruchomieniem (sesja lokalna, AGENTS.md „Wgrywanie migracji”):
--   SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 3;
--     → 00200, 00155, 00154 (00200 spoza kolejności, wgrana 02.10); jest 00151; nie ma 00156 (00149 nie było i nie będzie)
--   SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace
--      AND proname IN ('decide_ksef_duplicate', 'guard_ksef_retired_draft')
--      AND prosrc ILIKE '%faktflow%';
--     → 0 wierszy (00151 wgrana — inaczej najpierw 00151)
--   SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
--      AND proname = 'ksef_lifecycle_violations' AND prosrc LIKE '%ksef_upo_expected%';
--     → 1 (00155 wgrana — inaczej najpierw 00155)
--   SELECT count(*) FROM public.invoices WHERE ksef_status='failed' AND last_error_code='KSEF_DUPLICATE_RECONCILE';
--   SELECT original_check->>'reason', original_check ? 'importGate', count(*)
--     FROM public.ksef_submissions WHERE original_check IS NOT NULL GROUP BY 1, 2;
--   SELECT count(*) FROM public.ksef_submissions WHERE status='number_taken';
--   SELECT count(*) FROM public.invoices WHERE origin='ksef_import';
--   (informacyjnie — migracja nie zmienia wierszy)
-- Po wgraniu: wpis 00156 w schema_migrations, NOTIFY pgrst (nowe RPC:
-- decide_ksef_duplicate_original, release_ksef_original_review,
-- flag_ksef_original_recheck, ksef_duplicate_decision_blocker_for_session),
-- a prosrc decide_ksef_duplicate zawiera ksef_duplicate_decide_core.

BEGIN;

-- ─────────────────────────────────────────────────────────────────
-- 1. Polityka danych oryginału + faktflow-original (lustro TS: duplicateCheckAllows)
-- ─────────────────────────────────────────────────────────────────
-- Gałąź ELSE = 00148 bez zmian (INV-14). importGate NIE wchodzi do allows:
-- stan oceny pliku rozstrzygają blokada (6, krok 11c) i oferta (4), więc
-- znacznik bez bramy przechodzi allows i dostaje recheck-needed, nie reason.
-- sizeBytes rzutowany dopiero po sprawdzeniu tekstu liczby (CASE).
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
    AND p_check->>'reason' IN ('no-own-file', 'known-number', 'faktflow-original')
    AND jsonb_typeof(p_check->'sha256') = 'string'
    AND p_check->>'sha256' ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(p_check->'summary') = 'object'
    AND CASE
      WHEN p_check->>'reason' = 'faktflow-original' THEN
        jsonb_typeof(p_check->'ownHistory') = 'boolean'
        AND COALESCE(jsonb_typeof(p_check->'sameContentExceptHeader'), 'null') IN ('boolean', 'null')
        AND (p_check->'summary'->>'systemInfo' = 'KSeF SaaS v1.0'
             OR p_check->'summary'->>'systemInfo' ~ '^FaktFlow [0-9]')          -- D-A4-1b-3-SYS: przyszła postać
        AND jsonb_typeof(p_check->'archivePath') = 'string'
        AND p_check->>'archivePath' ~ '^[0-9a-f-]{36}/ksef-import/[A-Za-z0-9-]{1,64}\.xml$'
        AND CASE WHEN jsonb_typeof(p_check->'sizeBytes') = 'number'
                      AND p_check->>'sizeBytes' ~ '^[1-9][0-9]{0,9}$'
                 THEN (p_check->>'sizeBytes')::bigint <= 2147483647
                 ELSE false END
        AND (p_choice IS DISTINCT FROM 'other_sale'                              -- część JSON reguły „tylko zapis”;
             OR (p_check->'ownHistory' = 'false'::jsonb                          -- część z bazy rozstrzyga oferta (4)
                 AND p_check->'sameContentExceptHeader' IS DISTINCT FROM 'true'::jsonb))
      ELSE
        p_check->'ownHistory' = 'false'::jsonb
        AND (p_check->>'reason' <> 'known-number'
             OR (jsonb_typeof(p_check->'knownInvoice'->'id') = 'string'
                 AND p_check->'knownInvoice'->>'id' <> ''))
    END,
    false);
$$;
REVOKE ALL ON FUNCTION public.ksef_duplicate_check_allows(jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ksef_duplicate_check_allows(jsonb, text) TO service_role;
COMMENT ON FUNCTION public.ksef_duplicate_check_allows(jsonb, text) IS
  'Czy dane oryginału z original_check pozwalają zdecydować o duplikacie 440 (00148, 00156): v 1, bez decision, powód no-own-file, known-number albo faktflow-original, sha256 oryginału, summary. PR B: ownHistory false, przy known-number knownInvoice.id. faktflow-original: SystemInfo naszego programu (KSeF SaaS v1.0 albo FaktFlow <wersja>), archivePath, sizeBytes, ownHistory logiczne, other_sale tylko przy ownHistory false i treści różnej od true; importGate rozstrzyga blokada i oferta. Lustro TS: duplicateCheckAllows (lib/ksef/duplicate-decision.ts).';

-- ─────────────────────────────────────────────────────────────────
-- 2. Własna historia w bazie (predykat 00148 krok 12 jako funkcja)
-- ─────────────────────────────────────────────────────────────────
-- Sesja oryginału albo plik oryginału (SHA-256) w którejś próbie faktury.
-- Lustro TS: ownHistoryInSubmissions.
CREATE OR REPLACE FUNCTION public.ksef_duplicate_own_history(
  p_invoice_id uuid,
  p_tenant_id uuid,
  p_original_session text,
  p_sha256 text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.ksef_submissions s
     WHERE s.invoice_id = p_invoice_id
       AND s.tenant_id = p_tenant_id
       AND ((p_original_session IS NOT NULL AND s.session_reference_number = p_original_session)
            OR lower(s.request_payload_hash) = p_sha256));
$$;
REVOKE ALL ON FUNCTION public.ksef_duplicate_own_history(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ksef_duplicate_own_history(uuid, uuid, text, text) TO service_role;
COMMENT ON FUNCTION public.ksef_duplicate_own_history(uuid, uuid, text, text) IS
  'Własna historia oryginału w bazie (00156, predykat kroku 12 z 00148): któraś próba faktury ma sesję oryginału albo lower(request_payload_hash) = SHA-256 oryginału. Lustro TS: ownHistoryInSubmissions.';

-- ─────────────────────────────────────────────────────────────────
-- 3. Poprawny kształt importGate (wspólny dla 4, 6 i 12)
-- ─────────────────────────────────────────────────────────────────
-- Kolejne IF, nie jeden łańcuch AND: jsonb_array_length na nie-tablicy rzuca.
-- NULL na wejściu → false. Lustro TS: originalGateOk.
CREATE OR REPLACE FUNCTION public.ksef_duplicate_gate_ok(
  p_gate jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  -- 1. obiekt
  IF jsonb_typeof(p_gate) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;
  -- 2. v 1 (liczba), rules liczbą, kind importable albo review, problems tablicą
  IF p_gate->'v' IS DISTINCT FROM '1'::jsonb
     OR jsonb_typeof(p_gate->'rules') IS DISTINCT FROM 'number'
     OR COALESCE(p_gate->>'kind', '') NOT IN ('importable', 'review')
     OR jsonb_typeof(p_gate->'problems') IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;
  -- 3. każdy problem napisem (typ tablicy sprawdzony w 2)
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_gate->'problems') AS e(item)
              WHERE jsonb_typeof(e.item) <> 'string') THEN
    RETURN false;
  END IF;
  -- 4. importable ⇔ brak problemów
  RETURN (p_gate->>'kind' = 'importable') = (jsonb_array_length(p_gate->'problems') = 0);
END;
$$;
REVOKE ALL ON FUNCTION public.ksef_duplicate_gate_ok(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ksef_duplicate_gate_ok(jsonb) TO service_role;
COMMENT ON FUNCTION public.ksef_duplicate_gate_ok(jsonb) IS
  'Poprawny kształt original_check.importGate (00156): obiekt, v 1, rules liczbą, kind importable albo review, problems tablicą napisów; importable wtedy i tylko wtedy, gdy problems puste. Lustro TS: originalGateOk.';

-- ─────────────────────────────────────────────────────────────────
-- 4. Oferta z importGate i własnej historii (jedna funkcja dla panelu, powiadomień i operatora)
-- ─────────────────────────────────────────────────────────────────
-- Kolejne IF; każda zmienna logiczna jest true albo false, nigdy NULL
-- (sameContentExceptHeader null nie daje „tylko zapis”). p_own_history_db
-- NULL = nieznane = tylko zapis (fail-closed). Lustro TS: duplicateOriginalOffer.
CREATE OR REPLACE FUNCTION public.ksef_duplicate_original_offer(
  p_check jsonb,
  p_own_history_db boolean
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_record_only boolean;
  v_gate jsonb;
  v_gate_ok boolean;
BEGIN
  -- 1. tylko faktflow-original, które przechodzi allows
  IF p_check->>'reason' IS DISTINCT FROM 'faktflow-original'
     OR NOT public.ksef_duplicate_check_allows(p_check, NULL) THEN
    RETURN NULL;
  END IF;
  -- 2. „tylko zapis”: własna historia w JSON albo w bazie, ta sama treść
  v_record_only := COALESCE(p_check->'ownHistory' = 'true'::jsonb, false)
                   OR COALESCE(p_check->'sameContentExceptHeader' = 'true'::jsonb, false)
                   OR COALESCE(p_own_history_db, true);
  -- 3. brama
  v_gate := p_check->'importGate';
  v_gate_ok := public.ksef_duplicate_gate_ok(v_gate);
  -- 4. poprawna brama importable — zapis oryginału
  IF v_gate_ok AND v_gate->>'kind' = 'importable' THEN
    RETURN CASE WHEN v_record_only THEN 'record' ELSE 'pair' END;
  END IF;
  -- 5. poprawna brama z oddaniem decyzji przez operatora, bez „tylko zapis”
  IF v_gate_ok AND NOT v_record_only
     AND COALESCE(jsonb_typeof(v_gate->'release') = 'object', false)
     AND COALESCE(jsonb_typeof(v_gate->'release'->'at') = 'string', false)
     AND COALESCE(v_gate->'release'->>'via' = 'operator', false) THEN
    RETURN 'released';
  END IF;
  -- 6. review, brak bramy albo zły kształt — przegląd operatora
  RETURN CASE WHEN v_record_only THEN 'review-record' ELSE 'review-pair' END;
END;
$$;
REVOKE ALL ON FUNCTION public.ksef_duplicate_original_offer(jsonb, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ksef_duplicate_original_offer(jsonb, boolean) TO service_role;
COMMENT ON FUNCTION public.ksef_duplicate_original_offer(jsonb, boolean) IS
  'Oferta decyzji przy faktflow-original (00156): pair, record (własna historia w JSON albo w bazie, ta sama treść), released (operator oddał decyzję przy poprawnej bramie), review-pair albo review-record (przegląd, brak bramy, zły kształt); NULL poza faktflow-original albo gdy allows odmawia. p_own_history_db NULL = tylko zapis. Lustro TS: duplicateOriginalOffer.';

-- ─────────────────────────────────────────────────────────────────
-- 5. K albo numer X w innej firmie (INV-9, jedyne miejsce reguły)
-- ─────────────────────────────────────────────────────────────────
-- Ciało pisane parametrami pozycyjnymi: $1 firma, $2 numer KSeF oryginału,
-- $3 numer dokumentu (test R-C7 c wkleja prosrc do PREPARE i bada plan).
-- Gałąź 1: K na fakturze sprzedaży innej firmy (idx_invoices_ksef_number_unique).
-- Gałąź 2: numer X na fakturze sprzedaży innej firmy z tym samym NIP, która
-- była wysyłana (idx_tenants_nip, uq_invoices_tenant_outgoing_internal_number,
-- idx_submissions_invoice). Bez warunku środowiska (IDX-ENV — runbook).
CREATE OR REPLACE FUNCTION public.ksef_duplicate_cross_tenant(
  p_tenant_id uuid,
  p_ksef_number text,
  p_internal_number text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.invoices z
                  WHERE z.ksef_number = $2
                    AND z.tenant_id <> $1 AND z.direction = 'outgoing')
      OR ($3 IS NOT NULL AND EXISTS (
            SELECT 1
              FROM public.tenants t2
              JOIN public.invoices z ON z.tenant_id = t2.id
             WHERE t2.nip = (SELECT t.nip FROM public.tenants t WHERE t.id = $1)
               AND t2.id <> $1
               AND z.direction = 'outgoing'
               AND z.internal_number = $3
               AND EXISTS (SELECT 1 FROM public.ksef_submissions zs
                            WHERE zs.invoice_id = z.id)))
$$;
REVOKE ALL ON FUNCTION public.ksef_duplicate_cross_tenant(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ksef_duplicate_cross_tenant(uuid, text, text) TO service_role;
COMMENT ON FUNCTION public.ksef_duplicate_cross_tenant(uuid, text, text) IS
  'Inna firma (00156, INV-9): numer KSeF oryginału na fakturze sprzedaży innej firmy albo numer dokumentu na wysyłanej kiedyś fakturze sprzedaży innej firmy z tym samym NIP. Jedyne miejsce reguły; woła ją blokada decyzji (krok 11b). Tylko serwis.';

-- ─────────────────────────────────────────────────────────────────
-- 6. Blokada decyzji (NULL = faktura czeka na decyzję klienta)
-- ─────────────────────────────────────────────────────────────────
-- Ciało 00148 bez zmian w krokach 1–11 i 13; nowe kroki 11a (known-now),
-- 11b (cross-tenant), 11c (recheck-needed) i 14 (provenance-review) tylko dla
-- faktflow-original; krok 12 (own-history) NIE dla faktflow-original (tam
-- „tylko zapis”, oferta 4). Dla powodów PR B kody identyczne z 00148 (INV-14).
-- SECURITY INVOKER: jako service_role (RPC) widzi inne firmy, w funkcjach
-- DEFINER (7, 15) działa jako właściciel.
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
  v_ff boolean;
  v_own boolean;
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

  -- 4. kind: KOR, ZAL i ROZ bez decyzji (D-A4-1b-3-S).
  IF COALESCE(v_inv.invoice_kind::text, 'regular') <> 'regular' THEN
    RETURN 'kind';
  END IF;

  -- 5. billing: faktura abonamentu FaktWay.
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

  -- 10. reason: polityka danych oryginału (00156: także faktflow-original z danymi pliku).
  IF NOT public.ksef_duplicate_check_allows(v_marker.original_check, NULL) THEN
    RETURN 'reason';
  END IF;

  -- 11. known-stale (tylko powód known-number, C2) — 00148 bez zmian.
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

  -- Zmienne pomocnicze (00156): v_own liczone raz — dla PR B to dokładnie krok 12 z 00148.
  v_ff := COALESCE(v_marker.original_check->>'reason' = 'faktflow-original', false);
  v_own := public.ksef_duplicate_own_history(p_invoice_id, p_tenant_id,
             v_marker.original_session_reference_number, v_marker.original_check->>'sha256');

  -- 11a. known-now: K ma już inna faktura sprzedaży TEJ firmy (po werdykcie).
  IF v_ff AND EXISTS (
    SELECT 1 FROM public.invoices y                                  -- idx_inv_ksef_number (tenant_id, ksef_number)
     WHERE y.tenant_id = p_tenant_id
       AND y.direction = 'outgoing'
       AND y.id <> p_invoice_id
       AND y.ksef_number = v_marker.original_ksef_number
  ) THEN
    RETURN 'known-now';
  END IF;

  -- 11b. cross-tenant (INV-9) — jedyne miejsce reguły (funkcja 5).
  IF v_ff AND public.ksef_duplicate_cross_tenant(p_tenant_id, v_marker.original_ksef_number,
                                                 v_inv.internal_number) THEN
    RETURN 'cross-tenant';
  END IF;

  -- 11c. recheck-needed (INV-10 c, INV-25): brak poprawnej oceny pliku albo
  --      trwały znacznik po odmowie w chwili zapisu → I5, cron „Tylko uzgodnij”.
  IF v_ff AND (NOT public.ksef_duplicate_gate_ok(v_marker.original_check->'importGate')
               OR v_marker.original_check ? 'recheckNeeded') THEN
    RETURN 'recheck-needed';
  END IF;

  -- 12. own-history — 00148, ale NIE dla faktflow-original (tam „tylko zapis”, T3).
  IF NOT v_ff AND v_own THEN
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

  -- 14. provenance-review (OSTATNI, INV-22): poprawna brama review — przegląd operatora.
  IF v_ff AND COALESCE(public.ksef_duplicate_original_offer(v_marker.original_check, v_own) LIKE 'review-%', false) THEN
    RETURN 'provenance-review';
  END IF;

  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.ksef_duplicate_decision_blocker(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ksef_duplicate_decision_blocker(uuid, uuid) TO service_role;
COMMENT ON FUNCTION public.ksef_duplicate_decision_blocker(uuid, uuid) IS
  'Pierwszy powód, dla którego faktura nie czeka na decyzję klienta przy duplikacie 440 (00148, 00156): not-found, not-pending, in-ksef, kind, billing, offline, no-marker, conflicting-originals, no-check, reason, known-stale, known-now, cross-tenant, recheck-needed, own-history (nie dla faktflow-original), payments, provenance-review; NULL = czeka (I5D). Lustro TS: duplicateDecisionOptions.';

-- ─────────────────────────────────────────────────────────────────
-- 7. Blokada dla sesji klienta (strona faktury, firma z x-active-org)
-- ─────────────────────────────────────────────────────────────────
-- DEFINER: sesja dostaje tylko kod blokady WŁASNEJ faktury (faktura innej
-- firmy albo brak aktywnej firmy → not-found). Strona woła ją tylko przy
-- znaczniku faktflow-original (cross-tenant mówi tylko, że inna firma z tym
-- samym NIP ma K albo ten numer).
CREATE OR REPLACE FUNCTION public.ksef_duplicate_decision_blocker_for_session(
  p_invoice_id uuid
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_t uuid;
BEGIN
  v_t := public.get_current_tenant_id();
  IF v_t IS NULL THEN
    RETURN 'not-found';
  END IF;
  RETURN public.ksef_duplicate_decision_blocker(p_invoice_id, v_t);
END;
$$;
REVOKE ALL ON FUNCTION public.ksef_duplicate_decision_blocker_for_session(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ksef_duplicate_decision_blocker_for_session(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.ksef_duplicate_decision_blocker_for_session(uuid) IS
  'Blokada decyzji (ksef_duplicate_decision_blocker) dla sesji klienta (00156): firma z get_current_tenant_id(); brak aktywnej firmy albo faktura innej firmy → not-found. Strona faktury czyta nią kod przy znaczniku faktflow-original (bez klucza serwisowego).';

-- ─────────────────────────────────────────────────────────────────
-- 8. Kontrola projekcji oryginału (lustro TS: originalImportProjectionProblem)
-- ─────────────────────────────────────────────────────────────────
-- NULL albo PIERWSZY kod niezgodności: shape, lines, number, seller, kind,
-- issue-date, gross, buyer, currency, xml, totals, fa3. Nigdy nie rzuca: każde
-- sprawdzenie to osobny IF, każdy rzut poprzedza sprawdzenie typu i wzorca,
-- porównania przez IS DISTINCT FROM (NULL nie przepuszcza po cichu). Listy
-- kluczy i stawek = ORIGINAL_IMPORT_* w TS (test zapis-oryginalu-migracja).
-- number i seller = klient (P0001 IMPORT_MISMATCH), reszta = program (22023).
CREATE OR REPLACE FUNCTION public.ksef_original_import_mismatch(
  p_import jsonb,
  p_inv public.invoices,
  p_marker public.ksef_submissions,
  p_tenant_id uuid,
  p_tenant_nip text,
  p_offer text
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_invoice jsonb;
  v_lines jsonb;
  v_xml jsonb;
  v_line jsonb;
  v_check jsonb;
  v_summary jsonb;
  v_rates text[];
  v_ordinals numeric[] := ARRAY[]::numeric[];
  v_ordinal numeric;
  v_number text;
  v_text text;
BEGIN
  -- ── shape: obiekt v 1, invoice obiekt, lines tablica 1–1000, xml obiekt ──
  IF jsonb_typeof(p_import) IS DISTINCT FROM 'object'
     OR p_import->'v' IS DISTINCT FROM '1'::jsonb THEN
    RETURN 'shape';
  END IF;
  v_invoice := p_import->'invoice';
  v_lines := p_import->'lines';
  v_xml := p_import->'xml';
  IF jsonb_typeof(v_invoice) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_lines) IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_xml) IS DISTINCT FROM 'object' THEN
    RETURN 'shape';
  END IF;
  IF jsonb_array_length(v_lines) < 1 OR jsonb_array_length(v_lines) > 1000 THEN
    RETURN 'shape';
  END IF;

  -- shape: klucze nagłówka = ORIGINAL_IMPORT_INVOICE_KEYS (kolumny ustawiane przez SQL nie wolno podać).
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_invoice) AS kk(k)
              WHERE kk.k NOT IN ('internal_number', 'invoice_type', 'issue_date', 'sale_date', 'seller_nip',
                                 'buyer_nip', 'net_total', 'vat_total', 'gross_total', 'payment_due_date',
                                 'fa3_data', 'seller_data', 'buyer_data', 'payment_data', 'is_b2c',
                                 'buyer_id_type', 'buyer_pesel', 'buyer_id_number', 'notes')) THEN
    RETURN 'shape';
  END IF;

  -- shape: internal_number napis 1–100, invoice_type napis.
  IF jsonb_typeof(v_invoice->'internal_number') IS DISTINCT FROM 'string'
     OR jsonb_typeof(v_invoice->'invoice_type') IS DISTINCT FROM 'string' THEN
    RETURN 'shape';
  END IF;
  IF char_length(v_invoice->>'internal_number') NOT BETWEEN 1 AND 100 THEN
    RETURN 'shape';
  END IF;

  -- shape: daty — issue_date wymagana, sale_date i payment_due_date NULL albo data; potem rzut (np. 2026-02-30).
  IF jsonb_typeof(v_invoice->'issue_date') IS DISTINCT FROM 'string' THEN
    RETURN 'shape';
  END IF;
  IF (v_invoice->>'issue_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RETURN 'shape';
  END IF;
  IF COALESCE(jsonb_typeof(v_invoice->'sale_date'), 'null') <> 'null' THEN
    IF jsonb_typeof(v_invoice->'sale_date') <> 'string' THEN
      RETURN 'shape';
    END IF;
    IF (v_invoice->>'sale_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RETURN 'shape';
    END IF;
  END IF;
  IF COALESCE(jsonb_typeof(v_invoice->'payment_due_date'), 'null') <> 'null' THEN
    IF jsonb_typeof(v_invoice->'payment_due_date') <> 'string' THEN
      RETURN 'shape';
    END IF;
    IF (v_invoice->>'payment_due_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RETURN 'shape';
    END IF;
  END IF;
  BEGIN
    PERFORM (v_invoice->>'issue_date')::date,
            (v_invoice->>'sale_date')::date,
            (v_invoice->>'payment_due_date')::date;
  EXCEPTION WHEN others THEN
    RETURN 'shape';
  END;

  -- shape: NIP sprzedawcy 10 cyfr (napis), NIP nabywcy NULL albo 10 cyfr (napis).
  IF jsonb_typeof(v_invoice->'seller_nip') IS DISTINCT FROM 'string' THEN
    RETURN 'shape';
  END IF;
  IF (v_invoice->>'seller_nip') !~ '^[0-9]{10}$' THEN
    RETURN 'shape';
  END IF;
  IF COALESCE(jsonb_typeof(v_invoice->'buyer_nip'), 'null') <> 'null' THEN
    IF jsonb_typeof(v_invoice->'buyer_nip') <> 'string' THEN
      RETURN 'shape';
    END IF;
    IF (v_invoice->>'buyer_nip') !~ '^[0-9]{10}$' THEN
      RETURN 'shape';
    END IF;
  END IF;

  -- shape: sumy — liczby, |x| < 1e10, najwyżej 2 miejsca po przecinku (NUMERIC(12,2)).
  IF jsonb_typeof(v_invoice->'net_total') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_invoice->'vat_total') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_invoice->'gross_total') IS DISTINCT FROM 'number' THEN
    RETURN 'shape';
  END IF;
  IF abs((v_invoice->>'net_total')::numeric) >= 1e10 OR scale((v_invoice->>'net_total')::numeric) > 2
     OR abs((v_invoice->>'vat_total')::numeric) >= 1e10 OR scale((v_invoice->>'vat_total')::numeric) > 2
     OR abs((v_invoice->>'gross_total')::numeric) >= 1e10 OR scale((v_invoice->>'gross_total')::numeric) > 2 THEN
    RETURN 'shape';
  END IF;

  -- shape: dane jako obiekty.
  IF jsonb_typeof(v_invoice->'fa3_data') IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_invoice->'seller_data') IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_invoice->'buyer_data') IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_invoice->'payment_data') IS DISTINCT FROM 'object' THEN
    RETURN 'shape';
  END IF;

  -- shape: is_b2c logiczne, buyer_id_type z enum; konsument nie ma NIP (lustro check_b2c_has_id).
  IF jsonb_typeof(v_invoice->'is_b2c') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(v_invoice->'buyer_id_type') IS DISTINCT FROM 'string' THEN
    RETURN 'shape';
  END IF;
  IF (v_invoice->>'buyer_id_type') NOT IN ('nip', 'pesel', 'id_card', 'passport', 'no_id') THEN
    RETURN 'shape';
  END IF;
  IF v_invoice->'is_b2c' = 'true'::jsonb AND (v_invoice->>'buyer_id_type') = 'nip' THEN
    RETURN 'shape';
  END IF;

  -- shape: buyer_pesel NULL albo 11 cyfr (napis); buyer_id_number NULL albo napis ≤ 100; notes NULL albo napis ≤ 5000.
  IF COALESCE(jsonb_typeof(v_invoice->'buyer_pesel'), 'null') <> 'null' THEN
    IF jsonb_typeof(v_invoice->'buyer_pesel') <> 'string' THEN
      RETURN 'shape';
    END IF;
    IF (v_invoice->>'buyer_pesel') !~ '^[0-9]{11}$' THEN
      RETURN 'shape';
    END IF;
  END IF;
  IF COALESCE(jsonb_typeof(v_invoice->'buyer_id_number'), 'null') <> 'null' THEN
    IF jsonb_typeof(v_invoice->'buyer_id_number') <> 'string' THEN
      RETURN 'shape';
    END IF;
    IF char_length(v_invoice->>'buyer_id_number') > 100 THEN
      RETURN 'shape';
    END IF;
  END IF;
  IF COALESCE(jsonb_typeof(v_invoice->'notes'), 'null') <> 'null' THEN
    IF jsonb_typeof(v_invoice->'notes') <> 'string' THEN
      RETURN 'shape';
    END IF;
    IF char_length(v_invoice->>'notes') > 5000 THEN
      RETURN 'shape';
    END IF;
  END IF;

  -- ── lines: klucze = ORIGINAL_IMPORT_LINE_KEYS, typy i zakresy, stawki wg oferty ──
  -- pair/record (i każda inna): 8 stawek FaktWay (VAT_RATES); review-*: także FA(3) spoza FaktWay (F42); nieznana nigdy.
  v_rates := CASE WHEN p_offer IN ('review-pair', 'review-record')
                  THEN ARRAY['23', '8', '5', '0', 'zw', 'oo', 'np', 'np_ii', '0 WDT', '0 EX', '22', '7', '4', '3']
                  ELSE ARRAY['23', '8', '5', '0', 'zw', 'oo', 'np', 'np_ii'] END;
  FOR v_line IN SELECT x.item FROM jsonb_array_elements(v_lines) AS x(item) LOOP
    IF jsonb_typeof(v_line) IS DISTINCT FROM 'object' THEN
      RETURN 'lines';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_line) AS kk(k)
                WHERE kk.k NOT IN ('ordinal', 'name', 'unit', 'quantity', 'unit_price_net',
                                   'net_amount', 'vat_rate', 'vat_amount', 'gross_amount')) THEN
      RETURN 'lines';
    END IF;
    -- ordinal: liczba całkowita 1–100000, bez powtórzeń.
    IF jsonb_typeof(v_line->'ordinal') IS DISTINCT FROM 'number' THEN
      RETURN 'lines';
    END IF;
    v_ordinal := (v_line->>'ordinal')::numeric;
    IF v_ordinal <> trunc(v_ordinal) OR v_ordinal < 1 OR v_ordinal > 100000
       OR v_ordinal = ANY (v_ordinals) THEN
      RETURN 'lines';
    END IF;
    v_ordinals := v_ordinals || v_ordinal;
    -- name napis 1–512, unit napis 1–50 (znaki, jak VARCHAR).
    IF jsonb_typeof(v_line->'name') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_line->'unit') IS DISTINCT FROM 'string' THEN
      RETURN 'lines';
    END IF;
    IF char_length(v_line->>'name') NOT BETWEEN 1 AND 512
       OR char_length(v_line->>'unit') NOT BETWEEN 1 AND 50 THEN
      RETURN 'lines';
    END IF;
    -- quantity liczba ≤ 4 miejsca, |x| < 1e10 (NUMERIC(14,4)).
    IF jsonb_typeof(v_line->'quantity') IS DISTINCT FROM 'number' THEN
      RETURN 'lines';
    END IF;
    IF abs((v_line->>'quantity')::numeric) >= 1e10 OR scale((v_line->>'quantity')::numeric) > 4 THEN
      RETURN 'lines';
    END IF;
    -- unit_price_net NULL albo liczba ≤ 4 miejsca, |x| < 1e10 (NUMERIC(14,4) — inaczej INSERT pada na 22003).
    IF COALESCE(jsonb_typeof(v_line->'unit_price_net'), 'null') <> 'null' THEN
      IF jsonb_typeof(v_line->'unit_price_net') <> 'number' THEN
        RETURN 'lines';
      END IF;
      IF abs((v_line->>'unit_price_net')::numeric) >= 1e10 OR scale((v_line->>'unit_price_net')::numeric) > 4 THEN
        RETURN 'lines';
      END IF;
    END IF;
    -- kwoty netto, VAT, brutto: liczby ≤ 2 miejsca, |x| < 1e10 (NUMERIC(12,2)).
    IF jsonb_typeof(v_line->'net_amount') IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_line->'vat_amount') IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_line->'gross_amount') IS DISTINCT FROM 'number' THEN
      RETURN 'lines';
    END IF;
    IF abs((v_line->>'net_amount')::numeric) >= 1e10 OR scale((v_line->>'net_amount')::numeric) > 2
       OR abs((v_line->>'vat_amount')::numeric) >= 1e10 OR scale((v_line->>'vat_amount')::numeric) > 2
       OR abs((v_line->>'gross_amount')::numeric) >= 1e10 OR scale((v_line->>'gross_amount')::numeric) > 2 THEN
      RETURN 'lines';
    END IF;
    -- stawka napisem z listy oferty.
    IF jsonb_typeof(v_line->'vat_rate') IS DISTINCT FROM 'string' THEN
      RETURN 'lines';
    END IF;
    IF NOT ((v_line->>'vat_rate') = ANY (v_rates)) THEN
      RETURN 'lines';
    END IF;
  END LOOP;

  v_check := p_marker.original_check;
  v_summary := v_check->'summary';

  -- ── number (klient): numer X istnieje i zgadza się z projekcją oraz z plikiem (btrim po obu stronach) ──
  --    Numer w pliku napisem (fail-closed: brak albo inny typ = niezgodność), potem btrim.
  v_number := btrim(p_inv.internal_number);
  IF v_number IS NULL
     OR btrim(v_invoice->>'internal_number') IS DISTINCT FROM v_number
     OR jsonb_typeof(v_summary->'number') IS DISTINCT FROM 'string' THEN
    RETURN 'number';
  END IF;
  IF btrim(v_summary->>'number') IS DISTINCT FROM v_number THEN
    RETURN 'number';
  END IF;

  -- ── seller (klient): NIP sprzedawcy = NIP firmy ──
  IF (v_invoice->>'seller_nip') IS DISTINCT FROM p_tenant_nip THEN
    RETURN 'seller';
  END IF;

  -- ── kind ──
  IF (v_invoice->>'invoice_type') IS DISTINCT FROM 'VAT' THEN
    RETURN 'kind';
  END IF;

  -- ── issue-date: tekst, bez rzutu (xs:date może mieć strefę); brak daty w pliku = niezgodność ──
  IF jsonb_typeof(v_summary->'issueDate') IS DISTINCT FROM 'string' THEN
    RETURN 'issue-date';
  END IF;
  IF (v_summary->>'issueDate') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
     OR (v_invoice->>'issue_date') IS DISTINCT FROM left(btrim(v_summary->>'issueDate'), 10) THEN
    RETURN 'issue-date';
  END IF;

  -- ── gross: P_15 pliku jest kwotą równą gross_total co do grosza; brak = niezgodność ──
  IF jsonb_typeof(v_summary->'gross') IS DISTINCT FROM 'string' THEN
    RETURN 'gross';
  END IF;
  v_text := v_summary->>'gross';
  IF v_text !~ '^-?[0-9]+(\.[0-9]{1,2})?$' THEN
    RETURN 'gross';
  END IF;
  IF v_text::numeric IS DISTINCT FROM (v_invoice->>'gross_total')::numeric THEN
    RETURN 'gross';
  END IF;

  -- ── buyer: IS DISTINCT FROM — brak NIP po obu stronach to zgodność; NIP w pliku napisem albo brak ──
  IF COALESCE(jsonb_typeof(v_summary->'buyerNip'), 'null') NOT IN ('string', 'null') THEN
    RETURN 'buyer';
  END IF;
  IF (v_invoice->>'buyer_nip') IS DISTINCT FROM NULLIF(regexp_replace(v_summary->>'buyerNip', '[^0-9]', '', 'g'), '') THEN
    RETURN 'buyer';
  END IF;

  -- ── currency: problem tylko dla niepustej waluty ≠ PLN po upper(btrim(…)) (jak reguła 1 bramy) ──
  --    Waluta nie-napisem (poza brakiem) to też problem — jak tekst ->> w lustrze TS (niepusty, ≠ PLN).
  IF COALESCE(jsonb_typeof(v_summary->'currency'), 'null') NOT IN ('string', 'null')
     OR COALESCE(NULLIF(upper(btrim(v_summary->>'currency')), '') <> 'PLN', false) THEN
    RETURN 'currency';
  END IF;

  -- ── xml: plik w archiwum firmy pod numerem K, ze skrótem i rozmiarem znacznika ──
  IF jsonb_typeof(v_xml->'storage_path') IS DISTINCT FROM 'string'
     OR (v_xml->'storage_path') IS DISTINCT FROM (v_check->'archivePath')
     OR (v_xml->>'storage_path') IS DISTINCT FROM (p_tenant_id::text || '/ksef-import/' || p_marker.original_ksef_number || '.xml')
     OR jsonb_typeof(v_xml->'sha256') IS DISTINCT FROM 'string'
     OR (v_xml->'sha256') IS DISTINCT FROM (v_check->'sha256')
     OR jsonb_typeof(v_xml->'size_bytes') IS DISTINCT FROM 'number'
     OR (v_xml->'size_bytes') IS DISTINCT FROM (v_check->'sizeBytes') THEN
    RETURN 'xml';
  END IF;

  -- ── totals: sumy pozycji = nagłówek co do grosza (kwoty sprawdzone w lines) ──
  IF (SELECT sum((x.item->>'net_amount')::numeric) FROM jsonb_array_elements(v_lines) AS x(item))
       IS DISTINCT FROM (v_invoice->>'net_total')::numeric
     OR (SELECT sum((x.item->>'vat_amount')::numeric) FROM jsonb_array_elements(v_lines) AS x(item))
       IS DISTINCT FROM (v_invoice->>'vat_total')::numeric
     OR (SELECT sum((x.item->>'gross_amount')::numeric) FROM jsonb_array_elements(v_lines) AS x(item))
       IS DISTINCT FROM (v_invoice->>'gross_total')::numeric THEN
    RETURN 'totals';
  END IF;

  -- ── fa3: bez lines na górze, pochodzenie zapisu i skrót pliku ze znacznika ──
  IF (v_invoice->'fa3_data') ? 'lines'
     OR (v_invoice->'fa3_data'->'import'->>'source') IS DISTINCT FROM 'ksef_duplicate_decision'
     OR jsonb_typeof(v_invoice->'fa3_data'->'import'->'originalSha256') IS DISTINCT FROM 'string'
     OR (v_invoice->'fa3_data'->'import'->'originalSha256') IS DISTINCT FROM (v_check->'sha256') THEN
    RETURN 'fa3';
  END IF;

  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.ksef_original_import_mismatch(jsonb, public.invoices, public.ksef_submissions, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ksef_original_import_mismatch(jsonb, public.invoices, public.ksef_submissions, uuid, text, text) TO service_role;
COMMENT ON FUNCTION public.ksef_original_import_mismatch(jsonb, public.invoices, public.ksef_submissions, uuid, text, text) IS
  'Kontrola projekcji oryginału K przed zapisem (00156, 4.8): NULL albo pierwszy kod shape, lines, number, seller, kind, issue-date, gross, buyer, currency, xml, totals, fa3. Nie pisze i nie rzuca. number i seller = niezgodność z dokumentem albo firmą (P0001 IMPORT_MISMATCH), reszta = błąd programu (22023). Lustro TS: originalImportProjectionProblem.';

-- ─────────────────────────────────────────────────────────────────
-- 9. Ciało decyzji (tryby retire / import / no-import)
-- ─────────────────────────────────────────────────────────────────
-- retire = decide_ksef_duplicate z 00151 (00148 w marce FaktWay; powody PR B;
-- instrukcje (a), (c), (d), (e) i teksty odmów dosłownie z 00151 — INV-14). import = zapis oryginału K w tej samej
-- transakcji: wycofanie X (jak 00148), numer przechodzi z X na K, K jako
-- przyjęta faktura sprzedaży (origin ksef_import) z pozycjami, xml_documents,
-- sesją oryginału i wierszem upo_receipts. no-import = po oddaniu decyzji przez
-- operatora (oferta released): skutki 00148, dowód decyzji na znaczniku.
-- Każda odmowa to RAISE (cała transakcja się cofa). Teksty odmów = 6.3 / 00151
-- (DUPLICATE_DECISION_SQL_TEXTS, marka FaktWay), DETAIL = kod (4.14).
CREATE OR REPLACE FUNCTION public.ksef_duplicate_decide_core(
  p_mode text,
  p_offer text,
  p_invoice_id uuid,
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_choice text,
  p_via text,
  p_original_ksef_number text,
  p_original_sha256 text,
  p_env text,
  p_note text,
  p_import jsonb
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
  v_dec_mode text;
  v_dec_offer text;
  v_dec_imported text;
  v_dec_retired text;
  v_choice_label text;
  v_env_check text;
  v_env_now text;
  v_closed integer;
  v_ff boolean;
  v_own boolean;
  v_offer text;
  v_label text;
  v_tenant_nip text;
  v_mismatch text;
  v_k_id uuid;
  v_retired text;
  v_session text;
  v_acquired timestamptz;
  v_retired_doc jsonb;
  v_extra jsonb;
  v_upo_status text;
BEGIN
  -- 0. Rola i argumenty (00148) oraz tryb, oferta i projekcja (22023, teksty techniczne).
  IF current_user <> 'service_role' AND current_user <> 'postgres' THEN
    RAISE EXCEPTION 'KSeF duplicate decision is server-managed' USING ERRCODE = '42501';
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('retire', 'import', 'no-import') THEN
    RAISE EXCEPTION 'KSeF duplicate decision mode must be retire, import or no-import'
      USING ERRCODE = '22023';
  END IF;
  IF p_mode = 'retire'
     AND (p_offer IS NOT NULL OR COALESCE(jsonb_typeof(p_import), 'null') <> 'null') THEN
    RAISE EXCEPTION 'KSeF duplicate decision in retire mode takes no offer and no import'
      USING ERRCODE = '22023';
  END IF;
  IF p_mode = 'import'
     AND (p_offer IS NULL OR p_offer NOT IN ('pair', 'record', 'review-pair', 'review-record')) THEN
    RAISE EXCEPTION 'KSeF duplicate decision in import mode requires an import offer'
      USING ERRCODE = '22023';
  END IF;
  IF p_mode = 'import'
     AND (jsonb_typeof(p_import) IS DISTINCT FROM 'object' OR p_import->'v' IS DISTINCT FROM '1'::jsonb) THEN
    RAISE EXCEPTION 'KSeF duplicate decision in import mode requires an import projection v 1'
      USING ERRCODE = '22023';
  END IF;
  IF p_mode = 'no-import'
     AND (p_offer IS DISTINCT FROM 'released' OR COALESCE(jsonb_typeof(p_import), 'null') <> 'null') THEN
    RAISE EXCEPTION 'KSeF duplicate decision in no-import mode requires the released offer and no import'
      USING ERRCODE = '22023';
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
  --    (K i wybór) = already_decided bez zapisów i audytu; inna — ALREADY albo,
  --    gdy zapisano K, ALREADY_IMPORTED (numer przeszedł na K — v_num z decyzji).
  SELECT s.original_ksef_number,
         s.original_check->'decision'->>'choice',
         s.original_check->'decision'->>'via',
         s.original_check->'decision'->>'reason',
         s.original_check->'decision'->>'mode',
         s.original_check->'decision'->>'offer',
         s.original_check->'decision'->>'importedInvoiceId',
         s.original_check->'decision'->>'retiredInternalNumber'
    INTO v_dec_k, v_dec_choice, v_dec_via, v_dec_reason,
         v_dec_mode, v_dec_offer, v_dec_imported, v_dec_retired
    FROM public.ksef_submissions s
   WHERE s.invoice_id = p_invoice_id
     AND s.tenant_id = p_tenant_id
     AND s.status = 'number_taken'
     AND COALESCE(s.original_check ? 'decision', false)
   ORDER BY s.completed_at DESC NULLS LAST, s.id
   LIMIT 1;
  IF FOUND THEN
    v_num := COALESCE(v_inv.internal_number, v_dec_retired, '(bez numeru)');
    IF v_dec_k IS NOT DISTINCT FROM p_original_ksef_number
       AND v_dec_choice IS NOT DISTINCT FROM p_choice THEN
      -- Wynik 00148; klucze PR C tylko wtedy, gdy decyzja je ma (decyzje PR B bez zmian).
      RETURN jsonb_build_object(
        'invoice_id', p_invoice_id,
        'internal_number', v_inv.internal_number,
        'original_ksef_number', v_dec_k,
        'choice', v_dec_choice,
        'via', v_dec_via,
        'reason', v_dec_reason,
        'already_decided', true,
        'submissions_closed', 0)
        || jsonb_strip_nulls(jsonb_build_object(
          'mode', v_dec_mode,
          'offer', v_dec_offer,
          'imported_invoice_id', v_dec_imported,
          'retired_internal_number', v_dec_retired));
    END IF;
    IF v_dec_imported IS NOT NULL THEN
      v_label := CASE
        WHEN v_dec_offer IN ('record', 'review-record') THEN 'zapis faktury z KSeF'
        WHEN v_dec_choice = 'same_sale' THEN 'ta sama sprzedaż'
        ELSE 'inna sprzedaż'
      END;
      RAISE EXCEPTION 'Decyzja dla dokumentu % jest już zapisana („%”) — co zrobić, jeśli była błędna, piszemy na karcie wycofanego dokumentu.', v_num, v_label USING ERRCODE = 'P0001', DETAIL = 'already';
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
  -- Wyjątek INV-22: przegląd pliku zapisuje tylko operator z oferty review-* (6b);
  -- provenance-review stoi na końcu kolejności, więc wszystkie wcześniejsze
  -- sprawdzenia (także recheck-needed i payments) przeszły.
  IF v_code IS NOT NULL
     AND NOT (v_code = 'provenance-review' AND p_via = 'operator' AND p_mode = 'import') THEN
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
    ELSIF v_code = 'known-now' THEN
      RAISE EXCEPTION 'Faktura % z KSeF jest już zapisana w FaktWay przy innym dokumencie — sprawdzimy ją ponownie automatycznie (zwykle w ciągu 2 dni). Jeśli ten komunikat zostanie dłużej, napisz do nas: pomoc@faktway.pl. Nie wystawiaj dokumentu % ponownie.', v_marker.original_ksef_number, v_num USING ERRCODE = 'P0001', DETAIL = 'known-now';
    ELSIF v_code = 'cross-tenant' THEN
      RAISE EXCEPTION 'Faktury z KSeF o numerze % nie możemy zapisać przy tym dokumencie — wyjaśniamy to i damy znać. Nie wystawiaj dokumentu % ponownie; pytania: pomoc@faktway.pl.', v_num, v_num USING ERRCODE = 'P0001', DETAIL = 'cross-tenant';
    ELSIF v_code = 'recheck-needed' THEN
      RAISE EXCEPTION 'Fakturę z KSeF dla dokumentu % sprawdzamy jeszcze raz — automatycznie, zwykle w ciągu 2 dni; potem decyzję zapiszesz na tej karcie. Nie wystawiaj dokumentu ponownie; jeśli ten komunikat zostanie dłużej, napisz do nas: pomoc@faktway.pl.', v_num USING ERRCODE = 'P0001', DETAIL = 'recheck-needed';
    ELSIF v_code = 'own-history' THEN
      RAISE EXCEPTION 'Faktura % w KSeF może być wcześniejszą wersją dokumentu % wysłaną z FaktWay — tej decyzji nie zapiszesz w panelu. Nie wystawiaj go ponownie i napisz do nas: pomoc@faktway.pl, podając numer dokumentu.', v_marker.original_ksef_number, v_num USING ERRCODE = 'P0001';
    ELSIF v_code = 'payments' THEN
      RAISE EXCEPTION 'Na dokumencie % są zapisane wpłaty — decyzji nie zapiszemy, dopóki wpłaty są przy tym dokumencie. W FaktWay nie zmienisz ich sam: napisz do nas: pomoc@faktway.pl, podając numer dokumentu — ustalimy, przy której fakturze je zapisać. Nie wystawiaj go ponownie.', v_num USING ERRCODE = 'P0001';
    ELSIF v_code = 'provenance-review' THEN
      RAISE EXCEPTION 'Sprawdzamy fakturę z KSeF dla dokumentu % — nie wystawiaj go ponownie, damy znać. Pytania: pomoc@faktway.pl.', v_num USING ERRCODE = 'P0001', DETAIL = 'provenance-review';
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

  -- 6a. Tryb a powód (INV-8): retire tylko dla powodów PR B, import/no-import
  --     tylko dla faktflow-original.
  v_ff := COALESCE(v_marker.original_check->>'reason' = 'faktflow-original', false);
  IF (p_mode = 'retire' AND v_ff) OR (p_mode <> 'retire' AND NOT v_ff) THEN
    RAISE EXCEPTION 'Dane faktury w KSeF dla dokumentu % zmieniły się od otwarcia strony — odśwież stronę i zdecyduj jeszcze raz.', v_num USING ERRCODE = 'P0001', DETAIL = 'mode';
  END IF;

  IF p_mode <> 'retire' THEN
    -- 6b. Oferta liczona od nowa ze stanu bazy (T7, INV-8).
    v_own := public.ksef_duplicate_own_history(p_invoice_id, p_tenant_id,
               v_marker.original_session_reference_number, v_marker.original_check->>'sha256');
    v_offer := public.ksef_duplicate_original_offer(v_marker.original_check, v_own);
    IF p_offer IS DISTINCT FROM v_offer THEN
      RAISE EXCEPTION 'Dane faktury w KSeF dla dokumentu % zmieniły się od otwarcia strony — odśwież stronę i zdecyduj jeszcze raz.', v_num USING ERRCODE = 'P0001', DETAIL = 'offer';
    END IF;
    IF v_offer LIKE 'review-%' AND p_via <> 'operator' THEN
      -- Obrona: blokada (4) już to łapie.
      RAISE EXCEPTION 'Sprawdzamy fakturę z KSeF dla dokumentu % — nie wystawiaj go ponownie, damy znać. Pytania: pomoc@faktway.pl.', v_num USING ERRCODE = 'P0001', DETAIL = 'provenance-review';
    END IF;

    -- 6c. Wybór: allows z wyborem i „tylko zapis” przy ofercie record/review-record.
    IF NOT public.ksef_duplicate_check_allows(v_marker.original_check, p_choice)
       OR (v_offer IN ('record', 'review-record') AND p_choice <> 'same_sale') THEN
      RAISE EXCEPTION 'Dla dokumentu % możliwy jest tylko zapis faktury z KSeF jako tej samej sprzedaży — odśwież stronę.', v_num USING ERRCODE = 'P0001', DETAIL = 'choice';
    END IF;
    v_label := CASE
      WHEN v_offer IN ('record', 'review-record') THEN 'zapis faktury z KSeF'
      WHEN p_choice = 'same_sale' THEN 'ta sama sprzedaż'
      ELSE 'inna sprzedaż'
    END;
  END IF;

  IF p_mode = 'import' THEN
    -- 6d. Projekcja K (4.8): numer albo NIP sprzedawcy — klient (IMPORT_MISMATCH),
    --     reszta — błąd programu (22023).
    SELECT t.nip INTO v_tenant_nip FROM public.tenants t WHERE t.id = p_tenant_id;
    v_mismatch := public.ksef_original_import_mismatch(p_import, v_inv, v_marker, p_tenant_id, v_tenant_nip, v_offer);
    IF v_mismatch IN ('number', 'seller') THEN
      RAISE EXCEPTION 'Faktury % z KSeF nie zapiszemy przy dokumencie %: numer faktury albo NIP sprzedawcy w KSeF nie zgadza się z tym dokumentem albo z danymi Twojej firmy. Nie wystawiaj go ponownie i napisz do nas: pomoc@faktway.pl, podając numer dokumentu.', v_marker.original_ksef_number, v_num USING ERRCODE = 'P0001', DETAIL = 'import-mismatch:' || v_mismatch;
    ELSIF v_mismatch IS NOT NULL THEN
      RAISE EXCEPTION 'KSeF original import projection rejected' USING ERRCODE = '22023', DETAIL = 'import-projection:' || v_mismatch;
    END IF;
    v_k_id := gen_random_uuid();
    v_retired := v_inv.internal_number;
    v_session := v_marker.original_session_reference_number;
    -- Data nadania (C6, INV-16): tylko poprawny znacznik czasu, inaczej NULL — nigdy now().
    v_acquired := NULL;
    IF jsonb_typeof(v_marker.original_check->'acquiredAt') = 'string'
       AND (v_marker.original_check->>'acquiredAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN
      BEGIN
        v_acquired := (v_marker.original_check->>'acquiredAt')::timestamptz;
      EXCEPTION WHEN others THEN
        v_acquired := NULL;
      END;
    END IF;
  END IF;

  IF p_mode <> 'retire' THEN
    -- Dowód decyzji na wierszu 10-letnim (T6, INV-20): kim był X przed wycofaniem
    -- (nagłówek i wszystkie pozycje — D-A4-1b-3-XEDIT) i co widział decydujący.
    v_retired_doc := jsonb_build_object(
      'internalNumber', v_inv.internal_number,
      'issueDate', v_inv.issue_date,
      'saleDate', v_inv.sale_date,
      'buyerNip', v_inv.buyer_nip,
      'buyerName', v_inv.buyer_data->>'name',
      'netTotal', v_inv.net_total,
      'vatTotal', v_inv.vat_total,
      'grossTotal', v_inv.gross_total,
      'currency', v_inv.currency,
      'lineCount', (SELECT count(*) FROM public.invoice_line_items l WHERE l.invoice_id = p_invoice_id),
      'lines', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'ordinal', l.ordinal,
                 'name', l.name,
                 'unit', l.unit,
                 'quantity', l.quantity,
                 'unitPriceNet', l.unit_price_net,
                 'netAmount', l.net_amount,
                 'vatRate', l.vat_rate,
                 'vatAmount', l.vat_amount,
                 'grossAmount', l.gross_amount) ORDER BY l.ordinal, l.id)
          FROM public.invoice_line_items l
         WHERE l.invoice_id = p_invoice_id), '[]'::jsonb));
    v_extra := jsonb_build_object(
      'mode', p_mode,
      'offer', p_offer,
      'actorUserId', p_actor_user_id,
      'note', CASE WHEN p_via = 'operator' THEN p_note END,
      'original', jsonb_build_object(
        'sha256', v_marker.original_check->'sha256',
        'archivePath', v_marker.original_check->'archivePath',
        'sizeBytes', v_marker.original_check->'sizeBytes',
        'acquiredAt', v_marker.original_check->'acquiredAt',
        'session', v_marker.original_session_reference_number,
        'gateRules', v_marker.original_check->'importGate'->'rules',
        'gateProblems', v_marker.original_check->'importGate'->'problems',
        'buyerIdKind', v_marker.original_check->'importGate'->'preview'->'buyerIdKind'),
      'retired', v_retired_doc)
      || CASE WHEN p_mode = 'import'
              THEN jsonb_build_object('importedInvoiceId', v_k_id, 'retiredInternalNumber', v_retired)
              ELSE jsonb_build_object('release', v_marker.original_check->'importGate'->'release')
         END;
  END IF;

  IF p_mode = 'retire' THEN
    -- (a) Wszystkie otwarte wpisy → number_taken; decyzja tylko na wpisach
    --     z danymi tego oryginału (znacznik). Bez aktora i notatki. (00148)
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
  ELSE
    -- (a') To samo w trybach import / no-import: tekst wpisu przy zapisie K mówi,
    --      że numer ma faktura z KSeF zapisana w FaktWay; decyzja z dowodem (T6).
    UPDATE public.ksef_submissions s
       SET status = 'number_taken',
           error_code = 'NUMBER_TAKEN',
           completed_at = now(),
           error_message = CASE WHEN p_mode = 'import'
             THEN left(format('Decyzja klienta%s: %s — numer %s ma faktura %s z KSeF, zapisana w FaktWay',
                              CASE p_via WHEN 'operator' THEN ' (zapisał operator)' ELSE '' END,
                              v_label,
                              v_retired,
                              p_original_ksef_number), 500)
             ELSE left(format('Decyzja klienta%s: %s — numer %s zajęty w KSeF przez fakturę %s',
                              CASE p_via WHEN 'operator' THEN ' (zapisał operator)' ELSE '' END,
                              CASE p_choice WHEN 'same_sale' THEN 'ta sama sprzedaż' ELSE 'inna sprzedaż' END,
                              v_num,
                              p_original_ksef_number), 500)
           END,
           original_check = CASE
             WHEN s.original_ksef_number = p_original_ksef_number AND s.original_check IS NOT NULL
               THEN s.original_check || jsonb_build_object('decision', jsonb_build_object(
                      'choice', p_choice,
                      'via', p_via,
                      'at', now(),
                      'reason', s.original_check->>'reason',
                      'env', p_env) || v_extra)
             ELSE s.original_check
           END
     WHERE s.invoice_id = p_invoice_id
       AND s.tenant_id = p_tenant_id
       AND s.status IN ('intent', 'sent', 'duplicate');
    GET DIAGNOSTICS v_closed = ROW_COUNT;
  END IF;

  -- (b) Obrona: po zamknięciu wpisów i przy przejściu blokady dowodu kontaktu
  --     być nie może.
  IF public.ksef_has_contact_evidence(p_invoice_id, p_tenant_id) THEN
    RAISE EXCEPTION 'Dokument % mógł dotrzeć do KSeF w innej próbie — decyzji nie zapiszemy. Nie wystawiaj go ponownie i napisz do nas: pomoc@faktway.pl.', v_num USING ERRCODE = 'P0001';
  END IF;

  -- (c) Powrót do szkicu w miejscu, nie PERFORM reset_ksef_send: tamten
  --     odmawia klasie reconcile (00131) i zapisałby fałszywe previous_code.
  --     Pola jak w reset_ksef_send; internal_number zostaje w tym UPDATE —
  --     00132 mrozi numer, dopóki submitted_to_ksef_at jest ustawione.
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

  IF p_mode = 'import' THEN
    -- (c2) Numer przechodzi z X na oryginał K (C1). 00132 już nie mrozi numeru
    --      (pola wysyłki zdjęte w (c)), wyzwalacz numeru szkicu wycofanego
    --      przepuszcza serwis; X.fa3_data bez zmian (INV-3).
    UPDATE public.invoices
       SET internal_number = NULL
     WHERE id = p_invoice_id
       AND tenant_id = p_tenant_id
       AND ksef_status = 'draft';

    -- (c3) Faktura z KSeF: przyjęta faktura sprzedaży z projekcji (5.3); kolumny
    --      stałe ustawia SQL. Indeks numeru (00120): numer X zdjęty w (c2).
    INSERT INTO public.invoices (
      id, tenant_id, direction, origin, internal_number, ksef_status,
      ksef_environment, ksef_accepted_at, ksef_number, invoice_kind, invoice_type,
      issue_date, sale_date, seller_nip, buyer_nip, currency,
      net_total, vat_total, gross_total, payment_due_date,
      fa3_data, seller_data, buyer_data, payment_data,
      is_b2c, buyer_id_type, buyer_pesel, buyer_id_number, notes, xml_storage_path)
    SELECT v_k_id, p_tenant_id, 'outgoing', 'ksef_import', v_retired, 'accepted',
           p_env, v_acquired, v_marker.original_ksef_number, 'regular'::public.invoice_type_enum, 'VAT',
           r.issue_date, r.sale_date, r.seller_nip, r.buyer_nip, 'PLN',
           r.net_total, r.vat_total, r.gross_total, r.payment_due_date,
           jsonb_set(r.fa3_data, '{import,decision}', jsonb_build_object(
             'choice', p_choice,
             'via', p_via,
             'at', now(),
             'offer', p_offer,
             'actorUserId', p_actor_user_id,
             'note', CASE WHEN p_via = 'operator' THEN p_note END,
             'retiredInvoiceId', p_invoice_id,
             'retiredInternalNumber', v_retired,
             'markerSubmissionId', v_marker.id)),
           r.seller_data, r.buyer_data, r.payment_data,
           r.is_b2c, r.buyer_id_type, r.buyer_pesel, r.buyer_id_number, r.notes,
           v_marker.original_check->>'archivePath'
      FROM jsonb_populate_record(NULL::public.invoices, p_import->'invoice') AS r;

    -- (c4) Pozycje K (00119: K nie ma pól wysyłki ani offline — przechodzi).
    INSERT INTO public.invoice_line_items (
      invoice_id, ordinal, name, unit, quantity, unit_price_net,
      net_amount, vat_rate, vat_amount, gross_amount)
    SELECT v_k_id, r.ordinal, r.name, r.unit, r.quantity, r.unit_price_net,
           r.net_amount, r.vat_rate, r.vat_amount, r.gross_amount
      FROM jsonb_populate_recordset(NULL::public.invoice_line_items, p_import->'lines') AS r;

    -- (c5) Plik K: ten sam obiekt co archiwum oryginału (rozmiar sprawdzony w allows).
    INSERT INTO public.xml_documents (
      invoice_id, tenant_id, storage_provider, storage_path, sha256_hash, file_size_bytes)
    VALUES (v_k_id, p_tenant_id, 'r2', v_marker.original_check->>'archivePath',
            v_marker.original_check->>'sha256', (v_marker.original_check->>'sizeBytes')::integer);

    -- (c6) Sesja oryginału na K (kształt recordKsefAcceptedSession) — nigdy na X
    --      (wpis z response_ksef_number na X dałby blokadę in-ksef).
    IF v_session IS NOT NULL THEN
      INSERT INTO public.ksef_submissions (
        invoice_id, tenant_id, submission_type, status, session_reference_number,
        invoice_reference_number, response_ksef_number, request_payload_hash,
        xml_storage_path, attempted_at, completed_at)
      VALUES (v_k_id, p_tenant_id, 'online', 'accepted', v_session,
              NULL, v_marker.original_ksef_number, v_marker.original_check->>'sha256',
              v_marker.original_check->>'archivePath', now(), now());
    END IF;

    -- (c7) UPO K (T4, INV-18): pending przy znanej sesji (upo-retry-stale →
    --      download-upo), failed z tekstem NO_SESSION_REFERENCE bez sesji (I3K).
    --      COALESCE(…, now()) = zastępczy czas download-upo; finalize go nadpisze.
    v_upo_status := CASE WHEN v_session IS NULL THEN 'failed' ELSE 'pending' END;
    INSERT INTO public.upo_receipts (
      tenant_id, invoice_id, ksef_number, ksef_acceptance_timestamp,
      status, last_error, ksef_environment)
    VALUES (p_tenant_id, v_k_id, v_marker.original_ksef_number, COALESCE(v_acquired, now()),
            v_upo_status::public.upo_status_enum,
            CASE WHEN v_session IS NULL
                 THEN 'Brak numeru sesji KSeF dla tej faktury — UPO trzeba pobrać ręcznie w Aplikacji Podatnika KSeF' END,
            p_env);
  END IF;

  IF p_mode = 'retire' THEN
    -- (d) Audyt decyzji (aktor i notatka tylko tutaj). (00148)
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
  ELSE
    -- (d') Audyt decyzji jak 00148 + tryb, oferta i skutek zapisu (import).
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
          'xml_generated_at', v_inv.xml_generated_at),
        'mode', p_mode,
        'offer', p_offer,
        'import', jsonb_build_object(
          'imported_invoice_id', v_k_id,
          'acquired_at_missing', CASE WHEN p_mode = 'import' THEN v_acquired IS NULL END,
          'session_missing', CASE WHEN p_mode = 'import' THEN v_session IS NULL END,
          'gate_problems', v_marker.original_check->'importGate'->'problems',
          'release', v_marker.original_check->'importGate'->'release')
      ));
  END IF;

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

  IF p_mode = 'import' THEN
    -- (e2) Audyt na K: skąd się wzięła (retencja audytu 12 mies.; dowód 10-letni
    --      jest w K.fa3_data.import.decision i na znaczniku X).
    PERFORM public.ksef_send_audit(p_tenant_id, v_k_id, p_actor_user_id, 'invoice.ksef_original_imported',
      jsonb_build_object(
        'retired_invoice_id', p_invoice_id,
        'retired_internal_number', v_retired,
        'choice', p_choice,
        'offer', p_offer,
        'via', p_via,
        'original_ksef_number', v_marker.original_ksef_number,
        'session', v_session,
        'sha256', v_marker.original_check->>'sha256',
        'archive_path', v_marker.original_check->>'archivePath',
        'acquired_at', v_acquired,
        'upo_status', v_upo_status));
  END IF;

  -- (f) Wynik: 00148 + klucze trybu (import: K, numer, brak daty, brak sesji).
  RETURN jsonb_build_object(
    'invoice_id', p_invoice_id,
    'internal_number', v_inv.internal_number,
    'original_ksef_number', v_marker.original_ksef_number,
    'choice', p_choice,
    'via', p_via,
    'reason', v_marker.original_check->>'reason',
    'already_decided', false,
    'submissions_closed', v_closed)
    || CASE p_mode
         WHEN 'import' THEN jsonb_build_object(
           'mode', p_mode,
           'offer', p_offer,
           'imported_invoice_id', v_k_id,
           'retired_internal_number', v_retired,
           'acquired_at_missing', v_acquired IS NULL,
           'session_missing', v_session IS NULL)
         WHEN 'no-import' THEN jsonb_build_object(
           'mode', p_mode,
           'offer', p_offer,
           'imported_invoice_id', NULL::uuid,
           'retired_internal_number', NULL::text)
         ELSE '{}'::jsonb
       END;
END;
$$;
REVOKE ALL ON FUNCTION public.ksef_duplicate_decide_core(text, text, uuid, uuid, uuid, text, text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ksef_duplicate_decide_core(text, text, uuid, uuid, uuid, text, text, text, text, text, text, jsonb) TO service_role;
COMMENT ON FUNCTION public.ksef_duplicate_decide_core(text, text, uuid, uuid, uuid, text, text, text, text, text, text, jsonb) IS
  'Ciało decyzji przy nierozstrzygniętym duplikacie 440 (00156): retire = decide_ksef_duplicate z 00148 (powody PR B), import = wycofanie dokumentu i zapis oryginału K jako przyjętej faktury sprzedaży (numer przechodzi z dokumentu na K, pozycje, xml_documents, sesja oryginału, upo_receipts), no-import = po oddaniu decyzji przez operatora. Jedna transakcja; tryb, oferta, K, SHA-256 i środowisko wiązane ze stanem bazy (STALE). Wołają ją decide_ksef_duplicate i decide_ksef_duplicate_original.';

-- ─────────────────────────────────────────────────────────────────
-- 10. decide_ksef_duplicate (te same 9 argumentów co 00148 i 00151) — tryb retire
-- ─────────────────────────────────────────────────────────────────
-- Sygnatura, nazwy parametrów i wartość domyślna bez zmian (INV-14); stary kod
-- woła ją dla no-own-file / known-number z tym samym wynikiem i tekstami co w 00151.
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
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT public.ksef_duplicate_decide_core('retire', NULL, p_invoice_id, p_tenant_id, p_actor_user_id,
    p_choice, p_via, p_original_ksef_number, p_original_sha256, p_env, p_note, NULL);
$$;
REVOKE ALL ON FUNCTION public.decide_ksef_duplicate(uuid, uuid, uuid, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.decide_ksef_duplicate(uuid, uuid, uuid, text, text, text, text, text, text) TO service_role;
COMMENT ON FUNCTION public.decide_ksef_duplicate(uuid, uuid, uuid, text, text, text, text, text, text) IS
  'Decyzja klienta (albo operatora na jego prośbę) przy nierozstrzygniętym duplikacie 440 dla powodów no-own-file i known-number (00148, teksty FaktWay od 00151; od 00156 opakowanie ksef_duplicate_decide_core w trybie retire, ten sam wynik i te same teksty): same_sale albo other_sale, wpisy → number_taken z decision, faktura → szkic wycofany (numer zostaje), audyt invoice.ksef_duplicate_decided i invoice.send_reset. Dla faktflow-original odmawia STALE (DETAIL mode) — tam decide_ksef_duplicate_original.';

-- ─────────────────────────────────────────────────────────────────
-- 11. decide_ksef_duplicate_original — tryby import i no-import
-- ─────────────────────────────────────────────────────────────────
-- Osobna nazwa (nie przeciążenie): sygnatura z 00148 zostaje nietknięta, rola
-- wywołania jest jawna w nazwie; bez wartości domyślnych (PostgREST rozwiązuje
-- funkcję po nazwach argumentów).
CREATE OR REPLACE FUNCTION public.decide_ksef_duplicate_original(
  p_invoice_id uuid,
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_choice text,
  p_via text,
  p_original_ksef_number text,
  p_original_sha256 text,
  p_env text,
  p_note text,
  p_mode text,
  p_offer text,
  p_import jsonb
)
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT public.ksef_duplicate_decide_core(p_mode, p_offer, p_invoice_id, p_tenant_id, p_actor_user_id,
    p_choice, p_via, p_original_ksef_number, p_original_sha256, p_env, p_note, p_import);
$$;
REVOKE ALL ON FUNCTION public.decide_ksef_duplicate_original(uuid, uuid, uuid, text, text, text, text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.decide_ksef_duplicate_original(uuid, uuid, uuid, text, text, text, text, text, text, text, text, jsonb) TO service_role;
COMMENT ON FUNCTION public.decide_ksef_duplicate_original(uuid, uuid, uuid, text, text, text, text, text, text, text, text, jsonb) IS
  'Decyzja przy faktflow-original (00156): p_mode import (oferta pair, record, review-pair, review-record; zapis oryginału K z projekcją p_import) albo no-import (oferta released, po oddaniu decyzji przez operatora — semantyka 00148). Opakowanie ksef_duplicate_decide_core; tryb, oferta, K, SHA-256 i środowisko muszą zgadzać się ze stanem bazy (STALE).';

-- ─────────────────────────────────────────────────────────────────
-- 12. Operator oddaje decyzję klientowi (plik nie z FaktWay, T8, INV-21)
-- ─────────────────────────────────────────────────────────────────
-- Tylko przy blokadzie provenance-review, ofercie review-pair i poprawnej
-- bramie, z notatką. Odmowy dla operatora: P0001 z komunikatem-kodem (akcja
-- mapuje na teksty operatora). Skutek sprawdzony po zapisie (krok 9).
CREATE OR REPLACE FUNCTION public.release_ksef_original_review(
  p_invoice_id uuid,
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_original_ksef_number text,
  p_original_sha256 text,
  p_env text,
  p_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_inv public.invoices;
  v_marker public.ksef_submissions;
  v_own boolean;
  v_offer text;
  v_code text;
  v_new jsonb;
  v_release_at text;
BEGIN
  IF current_user <> 'service_role' AND current_user <> 'postgres' THEN
    RAISE EXCEPTION 'KSeF original release is server-managed' USING ERRCODE = '42501';
  END IF;

  -- 1. Argumenty.
  IF p_invoice_id IS NULL OR p_tenant_id IS NULL OR p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'KSeF original release requires an invoice, a tenant and an actor'
      USING ERRCODE = '22023';
  END IF;
  IF p_original_ksef_number IS NULL OR btrim(p_original_ksef_number) = '' THEN
    RAISE EXCEPTION 'KSeF original release requires the original KSeF number'
      USING ERRCODE = '22023';
  END IF;
  IF p_original_sha256 IS NULL OR p_original_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'KSeF original release requires a lowercase hex SHA-256 of the original'
      USING ERRCODE = '22023';
  END IF;
  IF p_env IS NULL OR p_env NOT IN ('test', 'demo', 'production') THEN
    RAISE EXCEPTION 'KSeF original release environment must be test, demo or production'
      USING ERRCODE = '22023';
  END IF;
  IF p_note IS NULL OR length(btrim(p_note)) < 10 OR length(p_note) > 1000 THEN
    RAISE EXCEPTION 'KSeF original release requires a note of 10 to 1000 characters'
      USING ERRCODE = '22023';
  END IF;

  -- 2. Blokady jak decyzja (00148): doradcza, faktura, znacznik.
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
  SELECT s.* INTO v_marker
    FROM public.ksef_submissions s
   WHERE s.invoice_id = p_invoice_id
     AND s.tenant_id = p_tenant_id
     AND s.status IN ('intent', 'sent')
     AND s.original_ksef_number IS NOT NULL
   ORDER BY s.attempted_at DESC NULLS LAST, s.id
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'release:not-review' USING ERRCODE = 'P0001', DETAIL = 'no-marker';
  END IF;

  -- 3. Wiązanie z tym, co operator widział.
  IF v_marker.original_ksef_number IS DISTINCT FROM p_original_ksef_number
     OR (v_marker.original_check->>'sha256') IS DISTINCT FROM p_original_sha256 THEN
    RAISE EXCEPTION 'release:stale' USING ERRCODE = 'P0001';
  END IF;
  IF (v_marker.original_check->>'env') IS DISTINCT FROM p_env THEN
    RAISE EXCEPTION 'release:env' USING ERRCODE = 'P0001';
  END IF;

  -- 4. Już oddane (zgubiona odpowiedź, podwójne kliknięcie) — bez zapisu i audytu.
  v_own := public.ksef_duplicate_own_history(p_invoice_id, p_tenant_id,
             v_marker.original_session_reference_number, v_marker.original_check->>'sha256');
  v_offer := public.ksef_duplicate_original_offer(v_marker.original_check, v_own);
  IF v_offer = 'released' THEN
    RETURN jsonb_build_object(
      'invoice_id', p_invoice_id,
      'original_ksef_number', v_marker.original_ksef_number,
      'already_released', true,
      'release_at', v_marker.original_check->'importGate'->'release'->>'at');
  END IF;

  -- 5. Tylko przegląd pliku (NULL = czeka na klienta; recheck-needed = najpierw nowa ocena).
  v_code := public.ksef_duplicate_decision_blocker(p_invoice_id, p_tenant_id);
  IF v_code IS DISTINCT FROM 'provenance-review' THEN
    RAISE EXCEPTION 'release:not-review' USING ERRCODE = 'P0001', DETAIL = COALESCE(v_code, 'none');
  END IF;

  -- 6. Plik w historii dokumentu albo ta sama treść — to plik z FaktWay (INV-19).
  IF v_offer IS DISTINCT FROM 'review-pair' THEN
    RAISE EXCEPTION 'release:own-file' USING ERRCODE = 'P0001';
  END IF;

  -- 7. Obrona: jsonb_set bez obiektu importGate nic by nie zapisał (F41).
  IF NOT public.ksef_duplicate_gate_ok(v_marker.original_check->'importGate') THEN
    RAISE EXCEPTION 'release:no-gate' USING ERRCODE = 'P0001';
  END IF;

  -- 8. Zapis oddania w pełnym kształcie {at, via, actorUserId, note}.
  UPDATE public.ksef_submissions s
     SET original_check = jsonb_set(s.original_check, '{importGate,release}', jsonb_build_object(
           'at', now(),
           'via', 'operator',
           'actorUserId', p_actor_user_id,
           'note', p_note))
   WHERE s.id = v_marker.id
  RETURNING s.original_check INTO v_new;

  -- 9. Sprawdzenie skutku: oferta released i faktura czeka na klienta — inaczej wszystko wycofane.
  IF public.ksef_duplicate_original_offer(v_new, v_own) IS DISTINCT FROM 'released'
     OR public.ksef_duplicate_decision_blocker(p_invoice_id, p_tenant_id) IS NOT NULL THEN
    RAISE EXCEPTION 'KSeF original release did not take effect' USING ERRCODE = 'XX000';
  END IF;
  v_release_at := v_new->'importGate'->'release'->>'at';

  -- 10. Audyt.
  PERFORM public.ksef_send_audit(p_tenant_id, p_invoice_id, p_actor_user_id, 'invoice.ksef_original_review_released',
    jsonb_build_object(
      'note', p_note,
      'original_ksef_number', v_marker.original_ksef_number,
      'sha256', v_marker.original_check->>'sha256',
      'gate_problems', v_marker.original_check->'importGate'->'problems',
      'release_at', v_release_at));

  -- 11. Wynik.
  RETURN jsonb_build_object(
    'invoice_id', p_invoice_id,
    'original_ksef_number', v_marker.original_ksef_number,
    'already_released', false,
    'release_at', v_release_at);
END;
$$;
REVOKE ALL ON FUNCTION public.release_ksef_original_review(uuid, uuid, uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_ksef_original_review(uuid, uuid, uuid, text, text, text, text) TO service_role;
COMMENT ON FUNCTION public.release_ksef_original_review(uuid, uuid, uuid, text, text, text, text) IS
  'Operator oddaje decyzję klientowi przy pliku z oznaczeniem FaktWay, który nie wygląda na plik generatora (00156, INV-21): tylko przy blokadzie provenance-review, ofercie review-pair i poprawnej bramie, z notatką; zapisuje importGate.release {at, via, actorUserId, note} i sprawdza, że oferta jest teraz released. Powtórzenie = already_released z tym samym release_at. Odmowy release:not-review, release:stale, release:env, release:own-file, release:no-gate.';

-- ─────────────────────────────────────────────────────────────────
-- 13. Trwały znacznik „sprawdź ponownie” (INV-25)
-- ─────────────────────────────────────────────────────────────────
-- Woła go akcja po odmowie w chwili zapisu (archiwum, inna ocena pliku,
-- niezgodność projekcji). Zmienia wyłącznie klucz recheckNeeded znacznika;
-- bez odmów P0001 (wynik flagged/reason), idempotentny.
CREATE OR REPLACE FUNCTION public.flag_ksef_original_recheck(
  p_invoice_id uuid,
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_original_ksef_number text,
  p_original_sha256 text,
  p_kind text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_inv public.invoices;
  v_marker public.ksef_submissions;
BEGIN
  IF current_user <> 'service_role' AND current_user <> 'postgres' THEN
    RAISE EXCEPTION 'KSeF original recheck flag is server-managed' USING ERRCODE = '42501';
  END IF;

  -- 1. Argumenty.
  IF p_invoice_id IS NULL OR p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'KSeF original recheck flag requires an invoice and a tenant'
      USING ERRCODE = '22023';
  END IF;
  IF p_original_ksef_number IS NULL OR btrim(p_original_ksef_number) = '' THEN
    RAISE EXCEPTION 'KSeF original recheck flag requires the original KSeF number'
      USING ERRCODE = '22023';
  END IF;
  IF p_original_sha256 IS NULL OR p_original_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'KSeF original recheck flag requires a lowercase hex SHA-256 of the original'
      USING ERRCODE = '22023';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('archive-missing', 'archive-mismatch', 'gate-drift',
                                      'import-mismatch', 'not-buildable', 'import-projection') THEN
    RAISE EXCEPTION 'KSeF original recheck flag kind is not supported'
      USING ERRCODE = '22023';
  END IF;

  -- 2. Blokady jak decyzja; faktura nie czeka już na decyzję → nic do oznaczenia.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('ksef_send:' || p_invoice_id::text));
  SELECT * INTO v_inv
    FROM public.invoices
   WHERE id = p_invoice_id
     AND tenant_id = p_tenant_id
     AND direction = 'outgoing'
   FOR UPDATE;
  IF NOT FOUND
     OR v_inv.ksef_status IS DISTINCT FROM 'failed'
     OR v_inv.last_error_code IS DISTINCT FROM 'KSEF_DUPLICATE_RECONCILE' THEN
    RETURN jsonb_build_object('flagged', false, 'reason', 'not-pending');
  END IF;

  -- 3. Znacznik (jak blokada krok 7): stan zmienił się od kliknięcia → stale.
  SELECT s.* INTO v_marker
    FROM public.ksef_submissions s
   WHERE s.invoice_id = p_invoice_id
     AND s.tenant_id = p_tenant_id
     AND s.status IN ('intent', 'sent')
     AND s.original_ksef_number IS NOT NULL
   ORDER BY s.attempted_at DESC NULLS LAST, s.id
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND
     OR v_marker.original_check IS NULL
     OR COALESCE(v_marker.original_check ? 'decision', false)
     OR (v_marker.original_check->>'reason') IS DISTINCT FROM 'faktflow-original'
     OR v_marker.original_ksef_number IS DISTINCT FROM p_original_ksef_number
     OR (v_marker.original_check->>'sha256') IS DISTINCT FROM p_original_sha256 THEN
    RETURN jsonb_build_object('flagged', false, 'reason', 'stale');
  END IF;

  -- 4. Już oznaczone — bez zapisu i audytu.
  IF v_marker.original_check ? 'recheckNeeded' THEN
    RETURN jsonb_build_object('flagged', false, 'already', true);
  END IF;

  -- 5. Znacznik (nowy werdykt runnera zapisze original_check bez tego klucza).
  UPDATE public.ksef_submissions s
     SET original_check = s.original_check || jsonb_build_object('recheckNeeded',
           jsonb_build_object('kind', p_kind, 'at', now()))
   WHERE s.id = v_marker.id;

  -- 6. Audyt.
  PERFORM public.ksef_send_audit(p_tenant_id, p_invoice_id, p_actor_user_id, 'invoice.ksef_original_recheck_flagged',
    jsonb_build_object(
      'kind', p_kind,
      'original_ksef_number', v_marker.original_ksef_number,
      'sha256', v_marker.original_check->>'sha256'));

  -- 7. Wynik.
  RETURN jsonb_build_object('flagged', true);
END;
$$;
REVOKE ALL ON FUNCTION public.flag_ksef_original_recheck(uuid, uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flag_ksef_original_recheck(uuid, uuid, uuid, text, text, text) TO service_role;
COMMENT ON FUNCTION public.flag_ksef_original_recheck(uuid, uuid, uuid, text, text, text) IS
  'Trwały znacznik „sprawdź ponownie” (00156, INV-25): original_check.recheckNeeded {kind, at} na otwartym znaczniku faktflow-original po odmowie w chwili zapisu (archive-missing, archive-mismatch, gate-drift, import-mismatch, not-buildable, import-projection). Blokada recheck-needed → I5 → cron Tylko uzgodnij. Wynik flagged true, already true albo reason not-pending / stale; nigdy nie zmienia faktury.';

-- ─────────────────────────────────────────────────────────────────
-- 14. Szkic wycofany: teksty po zapisie oryginału (wyzwalacze bez zmian)
-- ─────────────────────────────────────────────────────────────────
-- Ciało z 00151 (00148 w marce FaktWay) plus krok 3b: przy decyzji z zapisem
-- K (importedInvoiceId na wpisie number_taken) dokument nie ma już numeru —
-- teksty *_IMPORTED nazywają dawny numer (retiredInternalNumber) i fakturę K.
-- Bez importu — teksty i kolejność 00151 znak w znak (INV-14; FO-ODDANA też
-- tu). Nagłówek jak w 00148/00151. CREATE TRIGGER z 00148 bez zmian: wyzwalacze
-- wołają funkcję po nazwie.
CREATE OR REPLACE FUNCTION public.guard_ksef_retired_draft()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_k text;
  v_choice text;
  v_imported text;
  v_retired text;
  v_old text;
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
  --    czekał na blokadę wiersza (EvalPlanQual). 00156: także K zapisany
  --    decyzją (importedInvoiceId) i dawny numer dokumentu (retiredInternalNumber).
  SELECT s.original_ksef_number,
         s.original_check->'decision'->>'choice',
         s.original_check->'decision'->>'importedInvoiceId',
         s.original_check->'decision'->>'retiredInternalNumber'
    INTO v_k, v_choice, v_imported, v_retired
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

  -- 3b. 00156 (PR C): decyzja zapisała oryginał K — numer ma teraz K, dokument
  --     zostaje bez numeru. Teksty *_IMPORTED nazywają dawny numer
  --     (retiredInternalNumber) i fakturę K; kolejność jak w krokach 5–7.
  IF v_imported IS NOT NULL AND v_k IS NOT NULL THEN
    v_old := COALESCE(v_retired, OLD.internal_number, 'bez numeru');
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Wycofanego dokumentu (dawniej %) nie usuniesz: zostaje w FaktWay jako ślad decyzji o fakturze % z KSeF, która ma teraz jego numer. Jeśli musisz go usunąć, napisz do nas: pomoc@faktway.pl.', v_old, v_k USING ERRCODE = 'P0001';
    END IF;
    IF TG_NAME = 'c_guard_ksef_retired_draft_number' THEN
      IF NEW.direction IS DISTINCT FROM OLD.direction THEN
        RAISE EXCEPTION 'Wycofanego dokumentu (dawniej %) nie zmienisz na fakturę zakupową: zostaje w FaktWay jako ślad decyzji o fakturze % z KSeF.', v_old, v_k USING ERRCODE = 'P0001';
      END IF;
      RAISE EXCEPTION 'Wycofanemu dokumentowi (dawniej %) nie nadasz numeru — zostaje bez numeru jako ślad decyzji o fakturze % z KSeF. Inną sprzedaż wystaw jako nową fakturę z nowym numerem.', v_old, v_k USING ERRCODE = 'P0001';
    END IF;
    IF v_choice = 'other_sale' THEN
      RAISE EXCEPTION 'Wycofanego dokumentu (dawniej %) nie wyślesz do KSeF: numer % ma faktura % z KSeF, zapisana w FaktWay. Tę sprzedaż wystaw jako nową fakturę z nowym numerem.', v_old, v_old, v_k USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION 'Wycofanego dokumentu (dawniej %) nie wyślesz do KSeF: to ta sama sprzedaż co faktura % z KSeF, zapisana w FaktWay pod numerem %.', v_old, v_k, v_old USING ERRCODE = 'P0001';
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
COMMENT ON FUNCTION public.guard_ksef_retired_draft() IS
  'Szkic wycofany (wpis ksef_submissions number_taken, 00148, teksty FaktWay od 00151, 00156): nie wychodzi ze stanu draft (każda rola), a sesja klienta nie usuwa szkicu zwykłej faktury ani zaliczki (niezależnie od kierunku) i nie zmienia numeru ani kierunku szkicu żadnego rodzaju. Po decyzji z zapisem oryginału K (00156) teksty nazywają dawny numer dokumentu i fakturę K (numer ma teraz K). Serwis usuwa, przenumerowuje i zmienia kierunek za zgodą Bartosza.';

-- ─────────────────────────────────────────────────────────────────
-- 15. Strażnik: I5 bez przeglądu pliku, I5D + I5R, I3K (00155 + 00156)
-- ─────────────────────────────────────────────────────────────────
-- Ciało z 00155 (00148 z I3 przez ksef_upo_expected — każda redefinicja musi
-- go wołać, strażnik tests/unit/ksef-cykl-zycia-wersje.test.ts) z trzema
-- zmianami: I5 bez faktur w przeglądzie pliku (I5R — cron ich nie uzgadnia,
-- bez pętli; recheck-needed zostaje w I5, cron robi nową ocenę); I5D i I5R
-- jednym zapytaniem z blokadą liczoną raz na fakturę (OFFSET 0 w podzapytaniu
-- bocznym); I3K — faktura zapisana z KSeF decyzją bez sesji UPO albo bez daty
-- nadania (liczona od wpisów number_taken z decyzją importu, nie od fa3_data
-- wszystkich przyjętych faktur). Reszta (I1–I4, I9) znak w znak z 00155.
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
  -- 00155: brak UPO tylko, gdy UPO jest oczekiwane (ksef_upo_expected — faktury
  -- wysłane sesją FaktWay; historia z KSeF go nie ma, decyzja Bartosza 22.10.2026).
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
         OR (public.ksef_upo_expected(i) AND NOT EXISTS (SELECT 1 FROM public.upo_receipts u WHERE u.invoice_id = i.id))
       );

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
REVOKE ALL ON FUNCTION public.ksef_lifecycle_violations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ksef_lifecycle_violations() TO service_role;
COMMENT ON FUNCTION public.ksef_lifecycle_violations() IS
  'Naruszenia inwariantów cyklu życia faktury I1–I5, I9 (docs/architecture/cykl-zycia-faktury-ksef.md) oraz: I3 — brak UPO tylko, gdy ksef_upo_expected (00155); I5 także faktflow-original bez oceny pliku albo z recheckNeeded (cron robi nową ocenę), bez faktur czekających na klienta i bez przeglądu pliku; I5D — faktura czeka na decyzję klienta przy nierozstrzygniętym 440 (00148; nie alarm krytyczny, w raporcie osobno); I5R — przegląd pliku z oznaczeniem FaktWay przez operatora (00156); I3K — faktura zapisana z KSeF decyzją bez sesji UPO albo bez daty nadania (00156). I6–I8 realizuje cron i indeks unikalny numeru.';

-- ─────────────────────────────────────────────────────────────────
-- 16. Opis original_check: importGate, recheckNeeded, decision przy zapisie oryginału
-- ─────────────────────────────────────────────────────────────────
COMMENT ON COLUMN public.ksef_submissions.original_check IS
  'D-A4-1b-3 (00144): wynik weryfikacji duplikatu 440, którego automat nie rozstrzygnął — {v, env, checkedAt, reason (known-number | download-refused | download-pending | storage-pending | archive-pending | faktflow-original | same-content-other-program | no-own-file | archive-conflict), sha256, archivePath, sizeBytes, summary {systemInfo, number, issueDate, buyerNip, buyerName, gross, currency}, sameContentExceptHeader, ownHistory, acquiredAt, httpStatus, knownInvoice, recheck}. Tylko na otwartym wpisie ze znacznikiem 440; pisze serwer. Ponowne sprawdzenie, które nie pobrało oryginału, nie kasuje danych z udanego — zapisuje się w recheck. decision {choice, via, at, reason, env} — zapisuje wyłącznie decyzja (decide_ksef_duplicate 00148, ksef_duplicate_decide_core 00156), raz, gdy wpis staje się number_taken; obecność klucza = dokument wycofany decyzją klienta. Od 00148 powód known-number też niesie dane oryginału (sha256, summary, archivePath) i knownInvoice. 00156: importGate {v, rules, kind importable|review, problems[], preview, release? {at, via, actorUserId, note}} — ocena pliku oryginału przy faktflow-original (runner; release zapisuje tylko release_ksef_original_review). recheckNeeded {kind, at} — odmowa w chwili zapisu, faktura czeka na nowy werdykt (flag_ksef_original_recheck, cron I5; nowy werdykt zapisuje znacznik bez tego klucza). decision przy faktflow-original dokłada mode (import|no-import), offer, actorUserId, note (operator), original, retired, przy imporcie importedInvoiceId i retiredInternalNumber (numer przeszedł z dokumentu na fakturę z KSeF), przy no-import release.';

COMMIT;
