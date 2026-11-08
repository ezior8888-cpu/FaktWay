-- 00155_ksef_history_sync.sql
--
-- Automatyczna, ciągła synchronizacja historii faktur z KSeF (decyzja Bartosza
-- 22.10.2026): „Magiczny import” znika, FaktWay sam pobiera z KSeF całą
-- historię sprzedaży i zakupów firmy, a potem na bieżąco faktury sprzedaży
-- wystawione poza FaktWay. Projekt: docs/runbooks/synchronizacja-historii-ksef.md.
--
-- Co robi:
--   1. `ksef_history_sync` — strumień synchronizacji na (firma, środowisko KSeF,
--      kierunek): kursor zaległości (backfill: od najnowszych danych wstecz,
--      okna ≤ 90 dni, strony `pageOffset`), kursor bieżący (live, tylko sprzedaż)
--      i stan firmy (pauza po 429, pauza klienta, dzierżawa przebiegu, ostatni
--      błąd). Stan firmy żyje WYŁĄCZNIE na wierszu sprzedaży (CHECK).
--   2. `ksef_history_items` — dziennik faktur znalezionych w KSeF (jedna na
--      numer KSeF): pending / imported / skipped / deferred / blocked z powodem.
--      Pary status–powód pilnuje CHECK. Wiersz jest też „nagrobkiem”: faktura
--      usunięta przez retencję zostawia `imported` z `invoice_id` NULL i nie
--      jest pobierana drugi raz.
--   3. Widok `ksef_history_item_counts` (security_invoker) — liczniki dla ekranu.
--      Widok `ksef_history_export_changes` (security_invoker) — miesiące
--      wyeksportowanych okresów, do których po eksporcie doszły faktury
--      z historii (komunikat „wygeneruj eksport ponownie”). Liczy baza, nie
--      ekran z ograniczonej próbki — żaden okres nie ginie przy dużej historii.
--   4. RLS: klient czyta tylko swoją firmę, bez kolumn `last_error_detail`
--      i `detail` (uprawnienia kolumnowe jak w 00112). Pisze wyłącznie
--      `service_role` (worker). Bez prawa DELETE — wiersze znikają tylko
--      kaskadą z firmy (CASCADE) albo tracą powiązanie z fakturą (SET NULL).
--   5. `ksef_upo_expected(invoices)` — JEDNO źródło odpowiedzi „czy ta faktura
--      powinna mieć UPO”. UPO istnieje tylko dla faktur wysłanych sesją
--      FaktWay; faktura pobrana z KSeF (historia, dawny import) go nie ma,
--      chyba że jest powiązana z naszą wysyłką (oryginały 440 z PR C — wpis
--      w `ksef_submissions`). Używają go: strażnik I3 (niżej), cron
--      `upo-retry-stale` i raport `accepted24h` (filtr pola wyliczanego
--      PostgREST: `.filter('ksef_upo_expected','eq','true')`).
--   6. Dwa indeksy częściowe `ksef_submissions` po numerze KSeF odpowiedzi
--      i oryginału 440 — predykat i klasyfikacja historii pytają po nich.
--   7. `ksef_lifecycle_violations()` — ciało z 00148 (wiersze 743–853,
--      ostatnia definicja; 00151 jej nie zmienia) bez zmian poza warunkiem I3:
--      brak UPO jest naruszeniem tylko, gdy `ksef_upo_expected(i)`.
--      Każda późniejsza redefinicja MUSI wołać predykat (strażnik
--      tests/unit/ksef-cykl-zycia-wersje.test.ts). Uwaga dla PR C (00149):
--      przy przepisaniu tej funkcji weź ciało z 00155.
--
-- PRZED uruchomieniem (preflight):
--   SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 3;   -- ostatnia 00154
--   SELECT count(*) FROM public.ksef_submissions;   -- dwa indeksy budowane w transakcji; blokada ~ rozmiar (sekundy)
--   SELECT count(*) FROM public.invoices WHERE direction='outgoing' AND ksef_status='accepted' AND origin='ksef_import';
--     -- informacyjnie: te wiersze przestają wymagać UPO w I3, chyba że są powiązane z wysyłką
--   SELECT count(*) FROM public.upo_receipts r JOIN public.invoices i ON i.id=r.invoice_id
--    WHERE i.origin='ksef_import' AND r.status IN ('pending','failed');
--     -- informacyjnie: te UPO przestaną być ponawiane (bez powiązania z naszą wysyłką)
-- Wgrywać POZA szczytem wysyłek (budowa indeksów na `ksef_submissions`).
--
-- Kolejność: PRZED wdrożeniem kodu (addytywna: nowe tabele, widoki, funkcja,
-- indeksy; CREATE OR REPLACE strażnika z luźniejszym I3). Stary kod nowych
-- obiektów nie zna. Bez DROP, bez DELETE, bez TRUNCATE i bez DML.
-- Wycofanie (tylko za zgodą Bartosza — usuwa dziennik pobrań): przywrócenie
-- ciała strażnika z 00148, potem usunięcie widoków, tabel, funkcji i indeksów.

BEGIN;

-- ─────────────────────────────────────────────────────────────────
-- 1. Strumienie synchronizacji
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE public.ksef_history_sync (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('test', 'demo', 'production')),
  direction text NOT NULL CHECK (direction IN ('outgoing', 'incoming')),
  -- Najstarsza chwila, której szukamy: max(2022-01-01, data rozpoczęcia działalności).
  history_floor timestamptz NOT NULL,
  -- Granica zaległości: sprzedaż — S (chwila założenia strumienia − 1 h, pełna minuta),
  -- zakupy — U (HWM skrzynki przy założeniu). Zaległość szuka tylko < granicy.
  boundary_at timestamptz NOT NULL,
  -- Bieżące okno zaległości [backfill_cursor, backfill_window_end) i strona w nim.
  backfill_window_end timestamptz NOT NULL,
  backfill_cursor timestamptz NOT NULL,
  backfill_page_offset integer NOT NULL DEFAULT 0 CHECK (backfill_page_offset >= 0),
  backfill_completed_at timestamptz,
  backfill_progress_at timestamptz,
  backfill_issue text CHECK (backfill_issue IN ('waiting_for_ksef', 'internal', 'capacity')),
  backfill_issue_at timestamptz,
  -- Kursor bieżący (tylko sprzedaż): od tej chwili pytamy o nowe faktury.
  live_hwm timestamptz,
  live_page_offset integer NOT NULL DEFAULT 0 CHECK (live_page_offset >= 0),
  live_checked_at timestamptz,
  live_issue text CHECK (live_issue IN ('waiting_for_ksef', 'internal')),
  live_issue_at timestamptz,
  -- Stan firmy (tylko na wierszu sprzedaży — CHECK niżej).
  paused_until timestamptz,
  rate_limited_at timestamptz,
  rate_limit_hits integer NOT NULL DEFAULT 0 CHECK (rate_limit_hits >= 0),
  client_paused_at timestamptz,
  -- SET NULL przy usunięciu konta (RODO, jak 00113 i 00154).
  client_paused_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  lease_until timestamptz,
  last_enqueued_at timestamptz,
  last_run_at timestamptz,
  last_success_at timestamptz,
  last_error_code text CHECK (last_error_code IN ('credentials', 'certificate_expired', 'permission', 'ksef_unavailable', 'internal')),
  -- Tylko dla operatora (bez GRANT dla klienta): „HTTP {status} {ścieżka} kody:{…}”, nigdy treść odpowiedzi.
  last_error_detail text CHECK (char_length(last_error_detail) <= 300),
  last_error_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ksef_history_sync_identity UNIQUE (tenant_id, environment, direction),
  CONSTRAINT ksef_history_sync_live_only_outgoing CHECK ((direction = 'outgoing') = (live_hwm IS NOT NULL)),
  CONSTRAINT ksef_history_sync_window_order CHECK (
    history_floor <= backfill_cursor
    AND backfill_cursor <= backfill_window_end
    AND backfill_window_end <= boundary_at
  ),
  CONSTRAINT ksef_history_sync_tenant_state_on_outgoing CHECK (
    direction = 'outgoing'
    OR (paused_until IS NULL AND rate_limited_at IS NULL AND client_paused_at IS NULL
        AND lease_until IS NULL AND last_enqueued_at IS NULL AND last_error_code IS NULL)
  )
);

COMMENT ON TABLE public.ksef_history_sync IS
  'Synchronizacja historii z KSeF (decyzja Bartosza 22.10.2026, 00155): strumień na (firma, środowisko, kierunek). Zaległość wstecz do history_floor, sprzedaż także na bieżąco od live_hwm. Stan firmy (pauzy, dzierżawa, błąd) tylko na wierszu outgoing. Pisze wyłącznie worker (service_role).';

-- ─────────────────────────────────────────────────────────────────
-- 2. Dziennik faktur z KSeF
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE public.ksef_history_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('test', 'demo', 'production')),
  direction text NOT NULL CHECK (direction IN ('outgoing', 'incoming')),
  ksef_number text NOT NULL CHECK (char_length(ksef_number) BETWEEN 1 AND 64),
  invoice_number text NOT NULL,
  issue_date date NOT NULL,
  acquisition_at timestamptz,
  permanent_storage_at timestamptz,
  invoice_type text,
  counterparty_nip text,
  counterparty_name text,
  gross_amount numeric(14, 2),
  currency text,
  invoice_hash text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'imported', 'skipped', 'deferred', 'blocked')),
  reason_code text,
  -- Tylko dla operatora (bez GRANT dla klienta).
  detail text CHECK (char_length(detail) <= 300),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz,
  first_deferred_at timestamptz,
  invoice_id uuid,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ksef_history_items_identity UNIQUE (tenant_id, environment, direction, ksef_number),
  -- Faktura tylko z tej samej firmy (klucz złożony jak 00154). Usunięcie faktury
  -- (retencja) zeruje samo powiązanie — wiersz zostaje nagrobkiem.
  CONSTRAINT ksef_history_items_invoice_same_tenant_fk
    FOREIGN KEY (tenant_id, invoice_id)
    REFERENCES public.invoices (tenant_id, id)
    ON DELETE SET NULL (invoice_id),
  -- COALESCE: CHECK przepuszcza NULL, a `reason_code IN (…)` przy NULL daje
  -- NULL — bez tego `skipped`/`deferred`/`blocked` bez powodu by przeszło.
  CONSTRAINT ksef_history_items_status_reason CHECK (COALESCE(
    (status = 'pending' AND (reason_code IS NULL OR reason_code IN ('repair_content', 'ksef_not_ready')))
    OR (status = 'imported' AND (reason_code IS NULL OR reason_code IN ('jpk_note', 'repaired')))
    OR (status = 'skipped' AND reason_code IN ('own_invoice', 'already_present', 'retired_draft'))
    OR (status = 'deferred' AND reason_code IN ('duplicate_decision', 'own_send_pending')
        AND next_attempt_at IS NOT NULL)
    OR (status = 'blocked' AND reason_code IN (
          'currency_not_supported', 'parse_failed', 'number_conflict', 'number_taken_local',
          'file_import_mismatch', 'local_conflict', 'own_send_unresolved', 'save_failed',
          'repair_failed', 'download_failed', 'archive_conflict', 'metadata_mismatch'))
  , false))
);

COMMENT ON TABLE public.ksef_history_items IS
  'Dziennik faktur znalezionych przez synchronizację historii KSeF (00155): każda faktura z KSeF jest tu (pending/imported/skipped/deferred/blocked z powodem) albo jest fakturą FaktWay / ze Skrzynki KSeF. Wiersz imported z invoice_id NULL = faktura usunięta retencją, nie pobieramy jej ponownie.';

CREATE INDEX idx_ksef_history_items_stream_status
  ON public.ksef_history_items (tenant_id, environment, direction, status, issue_date DESC);
CREATE INDEX idx_ksef_history_items_open_reasons
  ON public.ksef_history_items (environment, status, reason_code)
  WHERE status IN ('blocked', 'deferred');
CREATE INDEX idx_ksef_history_items_imported_resolved
  ON public.ksef_history_items (tenant_id, environment, resolved_at)
  WHERE status = 'imported';

-- ─────────────────────────────────────────────────────────────────
-- 3. Liczniki dla ekranu
-- ─────────────────────────────────────────────────────────────────
CREATE VIEW public.ksef_history_item_counts
  WITH (security_invoker = true) AS
  SELECT tenant_id, environment, direction, status, reason_code, count(*)::int AS item_count
    FROM public.ksef_history_items
   GROUP BY tenant_id, environment, direction, status, reason_code;

COMMENT ON VIEW public.ksef_history_item_counts IS
  '00155: liczba faktur historii KSeF na (firma, środowisko, kierunek, status, powód). security_invoker — RLS i uprawnienia kolumnowe czytającego.';

-- Faktura liczy się, gdy pobraliśmy ją (bez napraw treści) PO zakończeniu
-- eksportu z ostatnich 24 miesięcy, którego okres obejmuje jej datę
-- wystawienia, a zakres — jej kierunek (wystawione / otrzymane). Filtr po
-- `tenant_id` z zapytania schodzi pod GROUP BY (kolumna grupowania).
CREATE VIEW public.ksef_history_export_changes
  WITH (security_invoker = true) AS
  SELECT i.tenant_id, i.environment, to_char(i.issue_date::timestamp, 'YYYY-MM') AS period, count(*)::int AS item_count
    FROM public.ksef_history_items i
   WHERE i.status = 'imported'
     AND i.reason_code IS DISTINCT FROM 'repaired'
     AND EXISTS (
       SELECT 1
         FROM public.export_jobs e
        WHERE e.tenant_id = i.tenant_id
          AND e.status = 'completed'
          AND e.completed_at IS NOT NULL
          AND e.completed_at > now() - interval '24 months'
          AND i.issue_date >= e.period_start
          AND i.issue_date <= e.period_end
          AND i.resolved_at > e.completed_at
          AND CASE WHEN i.direction = 'outgoing' THEN e.include_issued ELSE e.include_received END)
   GROUP BY i.tenant_id, i.environment, to_char(i.issue_date::timestamp, 'YYYY-MM');

COMMENT ON VIEW public.ksef_history_export_changes IS
  '00155: miesiące (RRRR-MM) wyeksportowanych okresów, do których po eksporcie (ostatnie 24 mies.) doszły faktury z historii KSeF — liczba na (firma, środowisko, miesiąc). security_invoker — RLS dziennika i export_jobs czytającego.';

-- ─────────────────────────────────────────────────────────────────
-- 4. updated_at
-- ─────────────────────────────────────────────────────────────────
CREATE TRIGGER trg_ksef_history_sync_updated_at
  BEFORE UPDATE ON public.ksef_history_sync
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_ksef_history_items_updated_at
  BEFORE UPDATE ON public.ksef_history_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────
-- 5. RLS i uprawnienia
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.ksef_history_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ksef_history_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ksef_history_sync_select_own_tenant"
  ON public.ksef_history_sync FOR SELECT
  TO authenticated
  USING (tenant_id = public.get_current_tenant_id());

CREATE POLICY "ksef_history_items_select_own_tenant"
  ON public.ksef_history_items FOR SELECT
  TO authenticated
  USING (tenant_id = public.get_current_tenant_id());

-- Domyślne uprawnienia Supabase dają nowej tabeli ALL (także TRUNCATE, które
-- omija RLS) — najpierw odbieramy wszystko, potem jawne prawa.
REVOKE ALL ON public.ksef_history_sync FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.ksef_history_items FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.ksef_history_item_counts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.ksef_history_export_changes FROM PUBLIC, anon, authenticated, service_role;

-- Klient: odczyt kolumn POZA szczegółem błędu (wzór 00112). Nowa kolumna
-- tych tabel wymaga odtąd jawnego GRANT SELECT (kolumna).
GRANT SELECT (
  id, tenant_id, environment, direction, history_floor, boundary_at,
  backfill_window_end, backfill_cursor, backfill_page_offset, backfill_completed_at,
  backfill_progress_at, backfill_issue, backfill_issue_at, live_hwm, live_page_offset,
  live_checked_at, live_issue, live_issue_at, paused_until, rate_limited_at,
  rate_limit_hits, client_paused_at, client_paused_by, lease_until, last_enqueued_at,
  last_run_at, last_success_at, last_error_code, last_error_at, consecutive_failures,
  created_at, updated_at
) ON public.ksef_history_sync TO authenticated;

GRANT SELECT (
  id, tenant_id, environment, direction, ksef_number, invoice_number, issue_date,
  acquisition_at, permanent_storage_at, invoice_type, counterparty_nip, counterparty_name,
  gross_amount, currency, invoice_hash, status, reason_code, attempts, next_attempt_at,
  first_deferred_at, invoice_id, discovered_at, resolved_at, updated_at
) ON public.ksef_history_items TO authenticated;

GRANT SELECT ON public.ksef_history_item_counts TO authenticated, service_role;
-- security_invoker: czytający potrzebuje też SELECT kolumn dziennika (GRANT wyżej,
-- bez `detail`) i `export_jobs` (00024) — widok ich nie omija.
GRANT SELECT ON public.ksef_history_export_changes TO authenticated, service_role;

-- Worker: odczyt i zapis, bez DELETE (backup czyta każdą tabelę jako service_role).
GRANT SELECT, INSERT, UPDATE ON public.ksef_history_sync TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.ksef_history_items TO service_role;

-- ─────────────────────────────────────────────────────────────────
-- 6. Predykat „ta faktura powinna mieć UPO”
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ksef_upo_expected(i public.invoices)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT CASE WHEN i.origin IS DISTINCT FROM 'ksef_import' THEN true
    ELSE EXISTS (
      SELECT 1 FROM public.ksef_submissions s
       WHERE s.tenant_id = i.tenant_id
         AND (s.invoice_id = i.id
              OR (i.ksef_number IS NOT NULL
                  AND (s.response_ksef_number = i.ksef_number
                       OR s.original_ksef_number = i.ksef_number))))
  END
$$;

REVOKE ALL ON FUNCTION public.ksef_upo_expected(public.invoices) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ksef_upo_expected(public.invoices) TO service_role;

COMMENT ON FUNCTION public.ksef_upo_expected(public.invoices) IS
  'UPO istnieje tylko dla faktur wysłanych sesją FaktWay; faktura z KSeF bez związku z naszą wysyłką (historia, dawny import) go nie ma — decyzja Bartosza 22.10.2026; oryginały 440 (PR C) mają wpis w ksef_submissions i UPO dalej jest wymagane. Jedno źródło dla I3, upo-retry-stale i accepted24h (00155).';

-- ─────────────────────────────────────────────────────────────────
-- 7. Indeksy pod predykat i klasyfikację historii
-- ─────────────────────────────────────────────────────────────────
CREATE INDEX idx_ksef_submissions_response_number
  ON public.ksef_submissions (tenant_id, response_ksef_number)
  WHERE response_ksef_number IS NOT NULL;

CREATE INDEX idx_ksef_submissions_original_number
  ON public.ksef_submissions (tenant_id, original_ksef_number)
  WHERE original_ksef_number IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────
-- 8. Strażnik: I3 przez predykat (00148 + 00155)
-- ─────────────────────────────────────────────────────────────────
-- Ciało z 00148 bez zmian poza warunkiem I3: brak UPO liczy się tylko, gdy
-- ksef_upo_expected(i). Brak numeru, środowiska albo pliku XML — jak dotąd.
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
  'Naruszenia inwariantów cyklu życia faktury I1–I5, I9 (docs/architecture/cykl-zycia-faktury-ksef.md) oraz I5D — faktura czeka na decyzję klienta przy nierozstrzygniętym 440 (00148; nie alarm krytyczny, w raporcie osobno; I5 jej nie zawiera). I3: UPO tylko gdy ksef_upo_expected (00155). I6–I8 realizuje cron i indeks unikalny numeru.';

COMMIT;
