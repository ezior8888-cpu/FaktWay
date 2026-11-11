-- ═══════════════════════════════════════════════════════════════
-- 00180: import wyciągu bankowego z dopasowaniem wpłat do faktur sprzedaży
-- (plan kompletnej aplikacji, krok 3.2, część 1; projekt N5 i ekran P12
-- z PLAN-FINORA.md).
--
-- Tabela operacji już jest: `payment_imports` (00014) z `tenant_id`, RLS
-- i UNIQUE (tenant_id, provider, transaction_id), zamknięta dla sesji (00074).
-- Ta migracja jej nie dubluje, tylko dokłada kolumny pod pliki z banku
-- i funkcje dla sesji. Tabela zostaje zamknięta: sesja czyta i pisze wyłącznie
-- przez RPC z firmą i rolą z sesji (owner, admin, member; księgowa tylko czyta).
--
-- Zasady (bezpieczniejsza wersja tam, gdzie plan był otwarty):
--   - zapisujemy tylko wpływy w złotych (RODO: dane potrzebne do dopasowania);
--     wypływy i inne waluty liczy aplikacja i ich nie przysyła;
--   - provider = 'bank_file' dla każdego formatu, a klucz duplikatu
--     (`transaction_id`, liczony w `lib/import/bank/klucz.ts`) nie zależy od
--     formatu, więc ta sama operacja z drugiego pliku, także MT940 po CSV,
--     nie wchodzi drugi raz (ON CONFLICT DO NOTHING);
--   - plik wchodzi w całości albo wcale (najpierw sprawdzenie wszystkich
--     operacji, potem jeden INSERT);
--   - wpłata powstaje dopiero po „Potwierdź” (`confirm_bank_operation`) przez
--     rdzeń `record_invoice_payment` (00176) z kluczem idempotencji z operacji
--     i dniem księgowania; potem ta sama transakcja oznacza wpłatę jako
--     `bank_import` i łączy ją z operacją;
--   - „Pomiń” usuwa dane osób trzecich (tytuł, nazwa, rachunek, NIP,
--     referencja), zostawia kwotę, dzień i klucz (żeby operacja nie wróciła);
--   - „Cofnij” cofa wpłatę ze śladem (`voided_at`, jak 00176), zwalnia
--     przypomnienia anulowane zapłatą i oddaje operację do sprawdzenia;
--     kolejne potwierdzenie dostaje nowy klucz (`confirm_attempt`).
--
-- Istniejące dane: `payment_imports` nie ma wierszy z aplikacji (nic do niej
-- nie pisało); nowe CHECK-i spełnia każdy wiersz z NULL w nowych kolumnach.
-- Kontrola przed wgraniem (oczekiwane 0):
--   SELECT count(*) FROM public.payment_imports WHERE provider = 'bank_file';
--
-- KIEDY WGRAĆ: PRZED wdrożeniem (addytywna: nowe kolumny NULL albo z domyślną
-- wartością, nowe CHECK-i, indeksy, wyzwalacz i funkcje). Stara wersja
-- aplikacji nowych funkcji nie woła. Bez DROP tabel i kolumn, bez TRUNCATE,
-- bez zmiany danych przy wgraniu; INSERT i UPDATE tylko w ciałach funkcji, na
-- żądanie klienta. Po wgraniu w `delivery-safety.ts` zaczynają się liczyć
-- operacje z wyciągu (wstrzymanie przypomnień na 48 h po imporcie, N5).
-- Rejestr numerów: docs/koordynacja/CLAUDE-DO-CODEXA.md.
-- ═══════════════════════════════════════════════════════════════

-- 1. Kolumny operacji z pliku.
ALTER TABLE public.payment_imports
  ADD COLUMN IF NOT EXISTS file_format text,
  ADD COLUMN IF NOT EXISTS import_batch_id uuid,
  ADD COLUMN IF NOT EXISTS imported_by uuid,
  ADD COLUMN IF NOT EXISTS decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS decided_by uuid,
  ADD COLUMN IF NOT EXISTS redacted_at timestamptz,
  ADD COLUMN IF NOT EXISTS confirm_attempt integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.payment_imports.file_format IS
  'Format pliku z banku (00180): mt940, camt053, csv_pko_elixir. NULL przy wierszach spoza plików.';
COMMENT ON COLUMN public.payment_imports.import_batch_id IS
  'Jedno wgranie pliku (00180); ten sam identyfikator stoi w audycie bank.statement_imported.';
COMMENT ON COLUMN public.payment_imports.decided_at IS
  'Potwierdzenie albo pominięcie przez klienta (00180); cofnięcie potwierdzenia czyści.';
COMMENT ON COLUMN public.payment_imports.redacted_at IS
  'Dane osób trzecich usunięte po „Pomiń” (00180, RODO): zostają kwota, dzień i klucz duplikatu.';
COMMENT ON COLUMN public.payment_imports.confirm_attempt IS
  'Numer potwierdzenia (00180): klucz idempotencji wpłaty to md5(operacja + numer), cofnięcie podnosi numer.';

-- DROP CONSTRAINT IF EXISTS tylko dla CHECK-ów z tej migracji, żeby dało się ją powtórzyć.
ALTER TABLE public.payment_imports DROP CONSTRAINT IF EXISTS payment_imports_file_format_check;
ALTER TABLE public.payment_imports ADD CONSTRAINT payment_imports_file_format_check
  CHECK (file_format IS NULL OR file_format IN ('mt940', 'camt053', 'csv_pko_elixir'));
ALTER TABLE public.payment_imports DROP CONSTRAINT IF EXISTS payment_imports_bank_file_check;
ALTER TABLE public.payment_imports ADD CONSTRAINT payment_imports_bank_file_check
  CHECK (provider <> 'bank_file' OR (file_format IS NOT NULL AND import_batch_id IS NOT NULL));
ALTER TABLE public.payment_imports DROP CONSTRAINT IF EXISTS payment_imports_confirm_attempt_check;
ALTER TABLE public.payment_imports ADD CONSTRAINT payment_imports_confirm_attempt_check
  CHECK (confirm_attempt >= 0);
-- Zamaskowany wiersz nie ma danych osób trzecich (także dla klucza serwisowego).
ALTER TABLE public.payment_imports DROP CONSTRAINT IF EXISTS payment_imports_redacted_check;
ALTER TABLE public.payment_imports ADD CONSTRAINT payment_imports_redacted_check
  CHECK (redacted_at IS NULL OR (title IS NULL AND counterparty_name IS NULL AND counterparty_account IS NULL
                                 AND counterparty_nip IS NULL AND reference IS NULL));

CREATE INDEX IF NOT EXISTS idx_payment_imports_matched_payment
  ON public.payment_imports (matched_payment_id) WHERE matched_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_imports_decided
  ON public.payment_imports (tenant_id, decided_at DESC) WHERE decided_at IS NOT NULL;

-- 2. Operacja z banku to dowód: kwota, dzień, rachunek i klucz nie zmieniają się,
--    a zamaskowania nie da się cofnąć. Usunięcie zostaje (kaskada z firmy).
CREATE OR REPLACE FUNCTION public.guard_payment_import_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
     OR NEW.account_iban IS DISTINCT FROM OLD.account_iban
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.transaction_date IS DISTINCT FROM OLD.transaction_date
     OR NEW.booking_date IS DISTINCT FROM OLD.booking_date
     OR NEW.file_format IS DISTINCT FROM OLD.file_format
     OR NEW.import_batch_id IS DISTINCT FROM OLD.import_batch_id
     OR NEW.imported_by IS DISTINCT FROM OLD.imported_by
     OR NEW.imported_at IS DISTINCT FROM OLD.imported_at THEN
    RAISE EXCEPTION 'Bank operation evidence is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.redacted_at IS NOT NULL AND NEW.redacted_at IS DISTINCT FROM OLD.redacted_at THEN
    RAISE EXCEPTION 'Redacted bank operation stays redacted' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER a_guard_payment_import_update
  BEFORE UPDATE ON public.payment_imports
  FOR EACH ROW EXECUTE FUNCTION public.guard_payment_import_update();

-- 3. Wgranie wpływów z pliku. Wynik: `imported` z liczbami albo `refused` z `code`.
CREATE OR REPLACE FUNCTION public.import_bank_operations(p_file_format text, p_operations jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  -- Dzień w Polsce, nie w strefie serwera.
  v_today date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
  v_batch uuid := gen_random_uuid();
  v_total integer;
  v_inserted integer := 0;
  v_index integer := 0;
  v_op jsonb;
  v_day date;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bank import requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.has_org_role(v_tenant_id, 'owner')
          OR public.has_org_role(v_tenant_id, 'admin')
          OR public.has_org_role(v_tenant_id, 'member')) THEN
    RAISE EXCEPTION 'Insufficient role to import bank statement' USING ERRCODE = '42501';
  END IF;
  IF p_file_format IS NULL OR p_file_format NOT IN ('mt940', 'camt053', 'csv_pko_elixir')
     OR p_operations IS NULL OR jsonb_typeof(p_operations) <> 'array' THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_request');
  END IF;
  v_total := jsonb_array_length(p_operations);
  IF v_total = 0 THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'no_operations');
  END IF;
  -- Ta sama granica co MAX_BANK_OPERATIONS w `lib/import/bank/ekran.ts`.
  IF v_total > 2000 THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'too_many');
  END IF;

  -- Najpierw cała paczka: jedna zła operacja to odmowa bez zapisu (plik w całości albo wcale).
  FOR v_op IN SELECT value FROM jsonb_array_elements(p_operations) LOOP
    IF jsonb_typeof(v_op) <> 'object'
       OR NOT (COALESCE(v_op ->> 'key', '') ~ '^v1:[0-9a-f]{64}$')
       OR NOT (COALESCE(v_op ->> 'account', '') ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{8,30}$')
       -- Tylko wpływy z groszami: NUMERIC(15,2) zaokrągliłby 10,005 po cichu.
       OR NOT (COALESCE(v_op ->> 'amount', '') ~ '^[0-9]{1,13}(\.[0-9]{1,2})?$')
       OR NOT (COALESCE(v_op ->> 'booking_date', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
       OR COALESCE(v_op ->> 'currency', '') <> 'PLN'
       OR char_length(COALESCE(v_op ->> 'title', '')) > 1000
       OR char_length(COALESCE(v_op ->> 'counterparty_name', '')) > 500
       OR char_length(COALESCE(v_op ->> 'counterparty_account', '')) > 64
       OR char_length(COALESCE(v_op ->> 'reference', '')) > 100 THEN
      RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_operation', 'index', v_index);
    END IF;
    BEGIN
      v_day := (v_op ->> 'booking_date')::date;
    EXCEPTION WHEN others THEN
      RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_operation', 'index', v_index);
    END;
    -- Dzień księgowania nie z przyszłości (dzień zapasu na strefę banku) i nie sprzed 2000 r.
    IF (v_op ->> 'amount')::numeric <= 0 OR v_day < DATE '2000-01-01' OR v_day > v_today + 1 THEN
      RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_operation', 'index', v_index);
    END IF;
    v_index := v_index + 1;
  END LOOP;

  INSERT INTO public.payment_imports (
    tenant_id, provider, account_iban, account_currency, transaction_id, transaction_date, booking_date,
    amount, currency, counterparty_name, counterparty_account, title, reference,
    file_format, import_batch_id, imported_by
  )
  SELECT v_tenant_id, 'bank_file', o ->> 'account', 'PLN', o ->> 'key',
         (o ->> 'booking_date')::date, (o ->> 'booking_date')::date,
         (o ->> 'amount')::numeric, 'PLN',
         NULLIF(btrim(o ->> 'counterparty_name'), ''), NULLIF(btrim(o ->> 'counterparty_account'), ''),
         NULLIF(btrim(o ->> 'title'), ''), NULLIF(btrim(o ->> 'reference'), ''),
         p_file_format, v_batch, auth.uid()
    FROM jsonb_array_elements(p_operations) AS e(o)
  ON CONFLICT (tenant_id, provider, transaction_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  -- Audyt bez danych osób trzecich: tylko liczby.
  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_tenant_id, auth.uid(), 'bank.statement_imported', 'bank_import', v_batch,
    jsonb_build_object('format', p_file_format, 'received', v_total, 'inserted', v_inserted, 'duplicates', v_total - v_inserted)
  );

  RETURN jsonb_build_object(
    'status', 'imported',
    'batch_id', v_batch,
    'received', v_total,
    'inserted', v_inserted,
    'duplicates', v_total - v_inserted
  );
END;
$$;

COMMENT ON FUNCTION public.import_bank_operations(text, jsonb) IS
  'Wgrywa wpływy w złotych z pliku z banku do payment_imports aktywnej firmy (provider bank_file): '
  'najpierw sprawdza całą paczkę, duplikaty po kluczu pomija (ON CONFLICT DO NOTHING), audyt bez danych osób trzecich (00180).';

-- 4. Lista dla ekranu „Bank”: wpływy do sprawdzenia (najwyżej 300, z danymi do
--    dopasowania), ostatnie decyzje (50) i rachunki. Czytają wszyscy członkowie firmy.
CREATE OR REPLACE FUNCTION public.bank_operations()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid := public.get_current_tenant_id();
BEGIN
  IF auth.uid() IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Bank operations require a session' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'pending', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', p.id,
               'account', p.account_iban,
               'booking_date', COALESCE(p.booking_date, p.transaction_date),
               'amount', p.amount,
               'currency', p.currency,
               'counterparty_name', p.counterparty_name,
               'counterparty_account', p.counterparty_account,
               'title', p.title,
               'imported_at', p.imported_at
             ) ORDER BY p.transaction_date DESC, p.id)
        FROM (
          SELECT * FROM public.payment_imports
           WHERE tenant_id = v_tenant_id AND provider = 'bank_file'
             AND NOT is_matched AND NOT ignored AND amount > 0
           ORDER BY transaction_date DESC, id
           LIMIT 300
        ) AS p
    ), '[]'::jsonb),
    'pending_total', (
      SELECT count(*) FROM public.payment_imports
       WHERE tenant_id = v_tenant_id AND provider = 'bank_file' AND NOT is_matched AND NOT ignored AND amount > 0
    ),
    'confirmed_total', (
      SELECT count(*) FROM public.payment_imports
       WHERE tenant_id = v_tenant_id AND provider = 'bank_file' AND is_matched AND matched_payment_id IS NOT NULL
    ),
    'skipped_total', (
      SELECT count(*) FROM public.payment_imports
       WHERE tenant_id = v_tenant_id AND provider = 'bank_file' AND ignored
    ),
    'decided', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', d.id,
               'booking_date', COALESCE(d.booking_date, d.transaction_date),
               'amount', d.amount,
               'state', CASE WHEN d.ignored THEN 'skipped' ELSE 'confirmed' END,
               'decided_at', d.decided_at,
               'invoice_id', i.id,
               'internal_number', i.internal_number,
               'counterparty_name', CASE WHEN d.ignored THEN NULL ELSE d.counterparty_name END,
               'title', CASE WHEN d.ignored THEN NULL ELSE d.title END
             ) ORDER BY d.decided_at DESC, d.id)
        FROM (
          SELECT * FROM public.payment_imports
           WHERE tenant_id = v_tenant_id AND provider = 'bank_file' AND decided_at IS NOT NULL
             AND (ignored OR (is_matched AND matched_payment_id IS NOT NULL))
           ORDER BY decided_at DESC, id
           LIMIT 50
        ) AS d
        LEFT JOIN public.payments AS pay ON pay.id = d.matched_payment_id AND pay.tenant_id = v_tenant_id
        LEFT JOIN public.invoices AS i ON i.id = pay.invoice_id AND i.tenant_id = v_tenant_id
    ), '[]'::jsonb),
    'accounts', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('account', a.account_iban, 'operations', a.n, 'last_imported_at', a.last_at)
                       ORDER BY a.last_at DESC, a.account_iban)
        FROM (
          SELECT account_iban, count(*) AS n, max(imported_at) AS last_at
            FROM public.payment_imports
           WHERE tenant_id = v_tenant_id AND provider = 'bank_file'
           GROUP BY account_iban
        ) AS a
    ), '[]'::jsonb)
  );
END;
$$;

COMMENT ON FUNCTION public.bank_operations() IS
  'Operacje z wyciągów aktywnej firmy dla ekranu „Bank”: wpływy do sprawdzenia, ostatnie decyzje bez danych pominiętych, rachunki (00180).';

-- 5. Potwierdzenie: wpłata przez rdzeń `record_invoice_payment` (00176) z kluczem
--    z operacji i dniem księgowania. Wynik: `confirmed`, `already_confirmed`
--    albo `refused` z `code` (także odmowy `record_invoice_payment` bez zmian).
CREATE OR REPLACE FUNCTION public.confirm_bank_operation(p_operation_id uuid, p_invoice_id uuid, p_match_kind text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  v_op public.payment_imports%ROWTYPE;
  v_linked public.payments%ROWTYPE;
  v_number text;
  v_key uuid;
  v_result jsonb;
  v_payment_id uuid;
  v_paid_on date;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bank operation change requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.has_org_role(v_tenant_id, 'owner')
          OR public.has_org_role(v_tenant_id, 'admin')
          OR public.has_org_role(v_tenant_id, 'member')) THEN
    RAISE EXCEPTION 'Insufficient role to change bank operation' USING ERRCODE = '42501';
  END IF;
  IF p_operation_id IS NULL OR p_invoice_id IS NULL OR p_match_kind IS NULL
     OR p_match_kind NOT IN ('ksef_number', 'invoice_number', 'amount_name', 'manual') THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_request');
  END IF;

  -- Blokada wiersza operacji: dwa potwierdzenia naraz (dwie karty, ponowienie) idą po kolei.
  SELECT * INTO v_op
    FROM public.payment_imports
   WHERE id = p_operation_id AND tenant_id = v_tenant_id AND provider = 'bank_file'
   FOR UPDATE;
  -- Operacja obcej firmy wygląda jak brak operacji.
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'operation_not_found');
  END IF;
  IF v_op.ignored THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'operation_skipped');
  END IF;
  IF v_op.is_matched AND v_op.matched_payment_id IS NOT NULL THEN
    SELECT * INTO v_linked FROM public.payments WHERE id = v_op.matched_payment_id AND tenant_id = v_tenant_id;
    SELECT internal_number INTO v_number FROM public.invoices WHERE id = v_linked.invoice_id AND tenant_id = v_tenant_id;
    IF v_linked.invoice_id = p_invoice_id AND v_linked.voided_at IS NULL THEN
      RETURN jsonb_build_object(
        'status', 'already_confirmed',
        'operation_id', v_op.id,
        'payment_id', v_linked.id,
        'invoice_id', v_linked.invoice_id,
        'amount', v_linked.amount,
        'paid_on', v_linked.payment_date,
        'internal_number', v_number
      );
    END IF;
    RETURN jsonb_build_object('status', 'refused', 'code', 'operation_confirmed', 'internal_number', v_number);
  END IF;
  IF v_op.amount <= 0 THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_credit');
  END IF;
  IF upper(btrim(v_op.currency)) <> 'PLN' THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'payment_currency');
  END IF;

  -- Klucz z operacji i numeru potwierdzenia: ponowienie trafia w tę samą wpłatę,
  -- a potwierdzenie po cofnięciu dostaje nowy klucz (stary zostaje przy cofniętej).
  v_key := md5('bank_import:' || v_op.id::text || ':' || v_op.confirm_attempt::text)::uuid;
  v_paid_on := COALESCE(v_op.booking_date, v_op.transaction_date);
  v_result := public.record_invoice_payment(p_invoice_id, v_op.amount, v_key, v_paid_on, NULL, 'PLN');
  IF v_result ->> 'status' = 'refused' THEN
    RETURN v_result;
  END IF;
  IF COALESCE(v_result ->> 'status', '') NOT IN ('recorded', 'already_recorded')
     OR COALESCE((v_result ->> 'voided')::boolean, false) THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'key_reused', 'internal_number', v_result ->> 'internal_number');
  END IF;
  v_payment_id := (v_result ->> 'payment_id')::uuid;

  -- Źródło i ślad operacji. Kolumny spoza listy wyzwalacza sumy: `paid_amount` się nie zmienia.
  UPDATE public.payments
     SET match_method = 'bank_import',
         payment_method = 'bank_transfer',
         bank_import_id = v_op.id,
         bank_transaction_ref = v_op.reference,
         match_confidence = CASE p_match_kind
           WHEN 'ksef_number' THEN 1.00
           WHEN 'invoice_number' THEN 0.90
           WHEN 'amount_name' THEN 0.50
           ELSE NULL
         END
   WHERE id = v_payment_id AND tenant_id = v_tenant_id AND voided_at IS NULL;

  UPDATE public.payment_imports
     SET is_matched = true,
         matched_payment_id = v_payment_id,
         decided_at = now(),
         decided_by = auth.uid()
   WHERE id = v_op.id AND tenant_id = v_tenant_id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_tenant_id, auth.uid(), 'bank.operation_confirmed', 'invoice', p_invoice_id,
    jsonb_build_object('operationId', v_op.id, 'paymentId', v_payment_id, 'matchKind', p_match_kind,
                       'amount', v_op.amount, 'paidOn', v_paid_on)
  );

  RETURN v_result || jsonb_build_object(
    'status', 'confirmed',
    'operation_id', v_op.id,
    'invoice_id', p_invoice_id,
    'match_kind', p_match_kind
  );
END;
$$;

COMMENT ON FUNCTION public.confirm_bank_operation(uuid, uuid, text) IS
  'Potwierdza wpływ z wyciągu jako wpłatę do faktury sprzedaży: record_invoice_payment (00176) z kluczem z operacji '
  'i dniem księgowania, potem źródło bank_import i połączenie z operacją, audyt bank.operation_confirmed, jedna transakcja (00180).';

-- 6. Pominięcie: dane osób trzecich usunięte, kwota, dzień i klucz zostają.
CREATE OR REPLACE FUNCTION public.skip_bank_operation(p_operation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  v_op public.payment_imports%ROWTYPE;
  v_number text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bank operation change requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.has_org_role(v_tenant_id, 'owner')
          OR public.has_org_role(v_tenant_id, 'admin')
          OR public.has_org_role(v_tenant_id, 'member')) THEN
    RAISE EXCEPTION 'Insufficient role to change bank operation' USING ERRCODE = '42501';
  END IF;
  IF p_operation_id IS NULL THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_request');
  END IF;

  SELECT * INTO v_op
    FROM public.payment_imports
   WHERE id = p_operation_id AND tenant_id = v_tenant_id AND provider = 'bank_file'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'operation_not_found');
  END IF;
  IF v_op.is_matched AND v_op.matched_payment_id IS NOT NULL THEN
    SELECT i.internal_number INTO v_number
      FROM public.payments AS p
      JOIN public.invoices AS i ON i.id = p.invoice_id AND i.tenant_id = p.tenant_id
     WHERE p.id = v_op.matched_payment_id AND p.tenant_id = v_tenant_id;
    RETURN jsonb_build_object('status', 'refused', 'code', 'operation_confirmed', 'internal_number', v_number);
  END IF;
  IF v_op.ignored THEN
    RETURN jsonb_build_object('status', 'already_skipped', 'operation_id', v_op.id);
  END IF;

  UPDATE public.payment_imports
     SET ignored = true,
         decided_at = now(),
         decided_by = auth.uid(),
         title = NULL,
         counterparty_name = NULL,
         counterparty_account = NULL,
         counterparty_nip = NULL,
         reference = NULL,
         redacted_at = now()
   WHERE id = v_op.id AND tenant_id = v_tenant_id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_tenant_id, auth.uid(), 'bank.operation_skipped', 'bank_operation', v_op.id,
    jsonb_build_object('amount', v_op.amount, 'bookingDate', COALESCE(v_op.booking_date, v_op.transaction_date))
  );

  RETURN jsonb_build_object('status', 'skipped', 'operation_id', v_op.id);
END;
$$;

COMMENT ON FUNCTION public.skip_bank_operation(uuid) IS
  'Pomija wpływ z wyciągu i usuwa dane osób trzecich (tytuł, nazwa, rachunek, NIP, referencja); audyt bez tych danych (00180).';

-- 7. Cofnięcie potwierdzenia: wpłata cofnięta ze śladem jak w `void_invoice_payment`
--    (00176), przypomnienia anulowane zapłatą zwolnione, operacja wraca do sprawdzenia.
CREATE OR REPLACE FUNCTION public.undo_bank_operation(p_operation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  v_op public.payment_imports%ROWTYPE;
  v_invoice public.invoices%ROWTYPE;
  v_payment public.payments%ROWTYPE;
  v_manual public.payments%ROWTYPE;
  v_invoice_id uuid;
  v_due numeric;
  v_paid numeric;
  v_status text;
  v_reminders integer := 0;
  v_voided boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bank operation change requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.has_org_role(v_tenant_id, 'owner')
          OR public.has_org_role(v_tenant_id, 'admin')
          OR public.has_org_role(v_tenant_id, 'member')) THEN
    RAISE EXCEPTION 'Insufficient role to change bank operation' USING ERRCODE = '42501';
  END IF;
  IF p_operation_id IS NULL THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_request');
  END IF;

  -- Kolejność blokad jak przy potwierdzeniu: operacja, faktura, wpłata.
  SELECT * INTO v_op
    FROM public.payment_imports
   WHERE id = p_operation_id AND tenant_id = v_tenant_id AND provider = 'bank_file'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'operation_not_found');
  END IF;
  IF NOT v_op.is_matched OR v_op.matched_payment_id IS NULL THEN
    RETURN jsonb_build_object('status', 'not_confirmed', 'operation_id', v_op.id);
  END IF;

  SELECT p.invoice_id INTO v_invoice_id
    FROM public.payments AS p
   WHERE p.id = v_op.matched_payment_id AND p.tenant_id = v_tenant_id;
  IF FOUND THEN
    SELECT * INTO v_invoice FROM public.invoices WHERE id = v_invoice_id AND tenant_id = v_tenant_id FOR UPDATE;
    SELECT * INTO v_payment FROM public.payments WHERE id = v_op.matched_payment_id AND tenant_id = v_tenant_id FOR UPDATE;
    IF v_payment.voided_at IS NULL THEN
      -- „Zapłacone” (00158) zapisało resztę policzoną po tej wpłacie: najpierw cofa się oznaczenie.
      SELECT * INTO v_manual
        FROM public.payments
       WHERE tenant_id = v_tenant_id AND invoice_id = v_invoice_id AND match_method = 'manual' AND voided_at IS NULL
       LIMIT 1;
      IF FOUND THEN
        RETURN jsonb_build_object('status', 'refused', 'code', 'manual_first',
          'manual_paid_on', v_manual.payment_date, 'manual_amount', v_manual.amount,
          'internal_number', v_invoice.internal_number);
      END IF;

      UPDATE public.payments
         SET voided_at = now(),
             voided_by = auth.uid()
       WHERE id = v_payment.id AND tenant_id = v_tenant_id;
      v_voided := true;

      -- Wyzwalacze przeliczyły już paid_amount, payment_status i paid_at.
      SELECT paid_amount, payment_status INTO v_paid, v_status
        FROM public.invoices
       WHERE id = v_invoice_id AND tenant_id = v_tenant_id;

      -- Ten sam blok co w void_invoice_payment (00176) i undo_invoice_paid (00158).
      IF v_status IS DISTINCT FROM 'paid' THEN
        WITH freed AS (
          DELETE FROM public.payment_reminders AS r
           WHERE r.tenant_id = v_tenant_id
             AND r.invoice_id = v_invoice_id
             AND r.status = 'cancelled'
             AND r.failure_reason = 'Faktura oznaczona jako zapłacona'
             AND r.sent_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM public.flo_approvals AS a
                WHERE a.id = r.id AND a.tenant_id = v_tenant_id AND a.snapshot ? 'reminderReceipt'
             )
          RETURNING r.id
        ), voided AS (
          UPDATE public.flo_approvals AS a
             SET snapshot = (a.snapshot - 'reminderDispatch') || jsonb_build_object(
                   'reminderDispatchVoided', jsonb_build_object(
                     'dispatch', a.snapshot -> 'reminderDispatch',
                     'voidedAt', now(),
                     'reason', 'undo_bank_operation'
                   )
                 )
            FROM freed
           WHERE a.id = freed.id
             AND a.tenant_id = v_tenant_id
             AND a.snapshot ? 'reminderDispatch'
          RETURNING a.id
        )
        SELECT count(*) INTO v_reminders FROM freed;
      END IF;

      IF v_invoice.invoice_kind = 'final'
         AND v_invoice.gross_total IS NOT NULL
         AND (v_invoice.payment_data ->> 'amountDue') ~ '^[0-9]+(\.[0-9]+)?$'
      THEN
        v_due := LEAST((v_invoice.payment_data ->> 'amountDue')::numeric, v_invoice.gross_total);
      ELSE
        v_due := v_invoice.gross_total;
      END IF;

      INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
      VALUES (
        v_tenant_id, auth.uid(), 'invoice.payment_voided', 'invoice', v_invoice_id,
        jsonb_build_object(
          'paymentId', v_payment.id,
          'amount', v_payment.amount,
          'paidOn', v_payment.payment_date,
          'source', v_payment.match_method,
          'remaining', GREATEST(COALESCE(v_due, 0) - v_paid, 0),
          'paymentStatus', v_status,
          'remindersRestored', v_reminders
        )
      );
    END IF;
  END IF;

  UPDATE public.payment_imports
     SET is_matched = false,
         matched_payment_id = NULL,
         decided_at = NULL,
         decided_by = NULL,
         confirm_attempt = confirm_attempt + 1
   WHERE id = v_op.id AND tenant_id = v_tenant_id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_tenant_id, auth.uid(), 'bank.operation_undone', 'bank_operation', v_op.id,
    jsonb_build_object('paymentId', v_op.matched_payment_id, 'invoiceId', v_invoice_id, 'amount', v_op.amount, 'voided', v_voided)
  );

  RETURN jsonb_build_object(
    'status', 'undone',
    'operation_id', v_op.id,
    'payment_id', v_op.matched_payment_id,
    'invoice_id', v_invoice_id,
    'amount', v_op.amount,
    'internal_number', v_invoice.internal_number,
    'reminders_restored', v_reminders
  );
END;
$$;

COMMENT ON FUNCTION public.undo_bank_operation(uuid) IS
  'Cofa potwierdzenie wpływu z wyciągu: wpłata oznaczona jako cofnięta (ślad), przypomnienia anulowane zapłatą zwolnione, '
  'operacja wraca do sprawdzenia z nowym numerem potwierdzenia; audyt invoice.payment_voided i bank.operation_undone (00180).';

-- 8. Uprawnienia. Supabase nadaje EXECUTE rolom anon i authenticated jawnie, samo
--    FROM PUBLIC nic nie odbiera (AUD-30). Tylko sesja zalogowanego: firma i autor z sesji.
REVOKE ALL ON FUNCTION public.import_bank_operations(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.import_bank_operations(text, jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.bank_operations() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bank_operations() TO authenticated;
REVOKE ALL ON FUNCTION public.confirm_bank_operation(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.confirm_bank_operation(uuid, uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.skip_bank_operation(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.skip_bank_operation(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.undo_bank_operation(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.undo_bank_operation(uuid) TO authenticated;
-- Funkcje wyzwalaczy nie są do wołania przez API.
REVOKE ALL ON FUNCTION public.guard_payment_import_update() FROM PUBLIC, anon, authenticated;
