-- ═══════════════════════════════════════════════════════════════
-- 00189: przelewy do ZUS i urzędu skarbowego z wyciągu jako zapłaty rozliczeń
-- modułu księgowości (plan kompletnej aplikacji, krok 3.2, część 2; po 00180).
--
-- Wypływ z pliku z banku trafia do `payment_imports` tylko jako przelew na
-- rachunek składkowy ZUS firmy (`tax_profiles.nrs_zus`, dowolna wersja) albo na
-- jej mikrorachunek podatkowy (NIP firmy w numerze 10100071222 + 2 + NIP + 00)
-- i tylko przy włączonym module dla firmy (`tenant_feature_flags.ksiegowosc_enabled`
-- bez globalnego `killKsiegowosc`). Inne wypływy dalej nie wchodzą (RODO, 00180).
-- Rachunek rozpoznaje aplikacja (`lib/import/bank/podatki.ts` z funkcjami modułu
-- księgowości); baza sprawdza go jeszcze raz, żeby sesja nie zapisała cudzego
-- wypływu z pominięciem akcji. Sumy kontrolnej mikrorachunku baza nie liczy:
-- porównuje NIP w numerze z NIP-em firmy.
--
-- Zapłata rozliczenia po „Potwierdź” (`confirm_bank_tax_payment`) idzie tą samą
-- drogą co „Zapłacone” w „Ten miesiąc”: UPDATE `tax_settlements` SET status
-- i dzień zapłaty (wyzwalacz `guard_tax_settlement_immutable` z 00168 puszcza
-- tylko te kolumny i odrzuca dzień z przyszłości), audyt `tax_settlement.paid`;
-- tutaj w jednej transakcji z operacją z wyciągu. Dzień zapłaty to dzień
-- księgowania (obciążenia rachunku). Kwota z banku zostaje przy operacji,
-- kwota rozliczenia się nie zmienia (różnica idzie do wyniku i audytu).
-- Rozliczenie już oznaczone jako zapłacone zostaje bez zmian: przelew dochodzi
-- do niego jako dowód. Jedno rozliczenie, jeden przelew (`settlement_linked`).
-- Tylko owner/admin (jak polityka UPDATE z 00168) i najnowsza wersja rozliczenia.
--
-- „Cofnij” (`undo_bank_tax_payment`) oddaje stan „zatwierdzone” rozliczeniom,
-- które oznaczyło to potwierdzenie, jeśli od tego czasu nikt ich nie zmienił
-- (dzień zapłaty nadal z wyciągu); zmienione zostają. Operacja wraca do sprawdzenia.
-- „Pomiń” (`skip_bank_operation`) odmawia przy potwierdzonej zapłacie.
--
-- Istniejące dane: `payment_imports` z plików ma tylko wpływy (00180 nie
-- przyjmowała wypływów), więc nowe CHECK-i spełnia każdy wiersz.
-- Kontrola przed wgraniem (oczekiwane 0):
--   SELECT count(*) FROM public.payment_imports WHERE provider = 'bank_file' AND amount <= 0;
--
-- KIEDY WGRAĆ: PRZED wdrożeniem, po 00180 (addytywna: nowe kolumny NULL, CHECK-i
-- spełnione przez istniejące wiersze, zastąpione funkcje z tą samą sygnaturą,
-- nowe funkcje). Stara wersja aplikacji nie wysyła `tax_kind`, więc
-- `import_bank_operations` działa dla niej jak w 00180. Bez DROP tabel i kolumn,
-- bez TRUNCATE, bez zmiany danych przy wgraniu; UPDATE i INSERT tylko w ciałach
-- funkcji, na żądanie klienta. Rejestr numerów: docs/koordynacja/CLAUDE-DO-CODEXA.md.
-- ═══════════════════════════════════════════════════════════════

-- 1. Kolumny przelewu podatkowego.
ALTER TABLE public.payment_imports
  ADD COLUMN IF NOT EXISTS tax_kind text,
  ADD COLUMN IF NOT EXISTS tax_settlement_ids uuid[],
  ADD COLUMN IF NOT EXISTS tax_marked_ids uuid[];

COMMENT ON COLUMN public.payment_imports.tax_kind IS
  'Przelew z wyciągu do ZUS (zus) albo na mikrorachunek podatkowy (us), 00189; wpływ ma NULL. Niezmienny.';
COMMENT ON COLUMN public.payment_imports.tax_settlement_ids IS
  'Rozliczenia (tax_settlements) zapłacone tym przelewem po „Potwierdź” (00189), rosnąco; NULL przed potwierdzeniem i po cofnięciu.';
COMMENT ON COLUMN public.payment_imports.tax_marked_ids IS
  'Rozliczenia, które potwierdzenie oznaczyło jako zapłacone (wcześniej zatwierdzone); cofnięcie oddaje im stan (00189).';

-- DROP CONSTRAINT IF EXISTS tylko dla CHECK-ów z tej migracji, żeby dało się ją powtórzyć.
ALTER TABLE public.payment_imports DROP CONSTRAINT IF EXISTS payment_imports_tax_kind_check;
ALTER TABLE public.payment_imports ADD CONSTRAINT payment_imports_tax_kind_check
  CHECK (tax_kind IS NULL OR tax_kind IN ('zus', 'us'));
-- Z pliku z banku: wpływ bez rodzaju, wypływ tylko jako przelew do ZUS albo urzędu.
ALTER TABLE public.payment_imports DROP CONSTRAINT IF EXISTS payment_imports_bank_file_direction_check;
ALTER TABLE public.payment_imports ADD CONSTRAINT payment_imports_bank_file_direction_check
  CHECK (provider <> 'bank_file' OR (amount > 0 AND tax_kind IS NULL) OR (amount < 0 AND tax_kind IS NOT NULL));
-- Przelew podatkowy nigdy nie jest wpłatą do faktury.
ALTER TABLE public.payment_imports DROP CONSTRAINT IF EXISTS payment_imports_tax_not_invoice_check;
ALTER TABLE public.payment_imports ADD CONSTRAINT payment_imports_tax_not_invoice_check
  CHECK (tax_kind IS NULL OR matched_payment_id IS NULL);
-- Potwierdzona zapłata: jedno albo dwa rozliczenia, oznaczone to ich część, operacja rozstrzygnięta.
ALTER TABLE public.payment_imports DROP CONSTRAINT IF EXISTS payment_imports_tax_link_check;
ALTER TABLE public.payment_imports ADD CONSTRAINT payment_imports_tax_link_check
  CHECK (
    (tax_settlement_ids IS NULL AND tax_marked_ids IS NULL)
    OR (tax_kind IS NOT NULL
        AND tax_settlement_ids IS NOT NULL AND cardinality(tax_settlement_ids) BETWEEN 1 AND 2
        AND tax_marked_ids IS NOT NULL AND tax_marked_ids <@ tax_settlement_ids
        AND is_matched AND NOT ignored AND decided_at IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_payment_imports_tax_pending
  ON public.payment_imports (tenant_id, transaction_date DESC)
  WHERE tax_kind IS NOT NULL AND NOT is_matched AND NOT ignored;

-- 2. Rodzaj przelewu jest dowodem jak kwota i rachunek: wyzwalacz z 00180 dostaje `tax_kind`.
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
     OR NEW.imported_at IS DISTINCT FROM OLD.imported_at
     OR NEW.tax_kind IS DISTINCT FROM OLD.tax_kind THEN
    RAISE EXCEPTION 'Bank operation evidence is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.redacted_at IS NOT NULL AND NEW.redacted_at IS DISTINCT FROM OLD.redacted_at THEN
    RAISE EXCEPTION 'Redacted bank operation stays redacted' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- 3. Wgranie: jak w 00180, a do tego przelewy do ZUS i urzędu (`tax_kind`, kwota ujemna).
--    Wynik `imported` ma też `tax_inserted`; odmowy `tax_module_disabled` i `tax_account`.
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
  v_tax_inserted integer := 0;
  v_index integer := 0;
  v_op jsonb;
  v_day date;
  v_kind text;
  v_amount numeric;
  v_account text;
  v_nip text := '';
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

  -- Przelewy podatkowe tylko przy włączonym module dla firmy; NIP do porównania z mikrorachunkiem.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_operations) AS e(o) WHERE NULLIF(o ->> 'tax_kind', '') IS NOT NULL) THEN
    IF NOT EXISTS (SELECT 1 FROM public.tenant_feature_flags AS f WHERE f.tenant_id = v_tenant_id AND f.ksiegowosc_enabled)
       OR EXISTS (SELECT 1 FROM public.global_feature_flags AS g WHERE g.flag = 'killKsiegowosc' AND g.enabled) THEN
      RETURN jsonb_build_object('status', 'refused', 'code', 'tax_module_disabled');
    END IF;
    SELECT regexp_replace(COALESCE(t.nip, ''), '[^0-9]', '', 'g') INTO v_nip FROM public.tenants AS t WHERE t.id = v_tenant_id;
    v_nip := COALESCE(v_nip, '');
  END IF;

  -- Najpierw cała paczka: jedna zła operacja to odmowa bez zapisu (plik w całości albo wcale).
  FOR v_op IN SELECT value FROM jsonb_array_elements(p_operations) LOOP
    IF jsonb_typeof(v_op) <> 'object'
       OR NOT (COALESCE(v_op ->> 'key', '') ~ '^v1:[0-9a-f]{64}$')
       OR NOT (COALESCE(v_op ->> 'account', '') ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{8,30}$')
       -- Grosze: NUMERIC(15,2) zaokrągliłby 10,005 po cichu. Minus tylko przy przelewie podatkowym (niżej).
       OR NOT (COALESCE(v_op ->> 'amount', '') ~ '^-?[0-9]{1,13}(\.[0-9]{1,2})?$')
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
    v_kind := NULLIF(v_op ->> 'tax_kind', '');
    v_amount := (v_op ->> 'amount')::numeric;
    -- Wpływ bez rodzaju; wypływ tylko jako przelew do ZUS albo urzędu. Dzień nie z przyszłości
    -- (dzień zapasu na strefę banku) i nie sprzed 2000 r.
    IF (v_kind IS NULL AND v_amount <= 0)
       OR (v_kind IS NOT NULL AND (v_kind NOT IN ('zus', 'us') OR v_amount >= 0))
       OR v_day < DATE '2000-01-01' OR v_day > v_today + 1 THEN
      RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_operation', 'index', v_index);
    END IF;
    IF v_kind IS NOT NULL THEN
      v_account := upper(regexp_replace(COALESCE(v_op ->> 'counterparty_account', ''), '\s', '', 'g'));
      IF NOT (v_account ~ '^PL[0-9]{26}$')
         OR (v_kind = 'zus' AND NOT EXISTS (
               SELECT 1 FROM public.tax_profiles AS p
                WHERE p.tenant_id = v_tenant_id AND p.nrs_zus = substr(v_account, 3)))
         OR (v_kind = 'us' AND NOT (v_nip ~ '^[0-9]{10}$' AND substr(v_account, 5) = '101000712222' || v_nip || '00')) THEN
        RETURN jsonb_build_object('status', 'refused', 'code', 'tax_account', 'index', v_index);
      END IF;
    END IF;
    v_index := v_index + 1;
  END LOOP;

  WITH inserted AS (
    INSERT INTO public.payment_imports (
      tenant_id, provider, account_iban, account_currency, transaction_id, transaction_date, booking_date,
      amount, currency, counterparty_name, counterparty_account, title, reference,
      file_format, import_batch_id, imported_by, tax_kind
    )
    SELECT v_tenant_id, 'bank_file', o ->> 'account', 'PLN', o ->> 'key',
           (o ->> 'booking_date')::date, (o ->> 'booking_date')::date,
           (o ->> 'amount')::numeric, 'PLN',
           NULLIF(btrim(o ->> 'counterparty_name'), ''), NULLIF(btrim(o ->> 'counterparty_account'), ''),
           NULLIF(btrim(o ->> 'title'), ''), NULLIF(btrim(o ->> 'reference'), ''),
           p_file_format, v_batch, auth.uid(), NULLIF(o ->> 'tax_kind', '')
      FROM jsonb_array_elements(p_operations) AS e(o)
    ON CONFLICT (tenant_id, provider, transaction_id) DO NOTHING
    RETURNING tax_kind
  )
  SELECT count(*), count(*) FILTER (WHERE tax_kind IS NOT NULL) INTO v_inserted, v_tax_inserted FROM inserted;

  -- Audyt bez danych osób trzecich: tylko liczby.
  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_tenant_id, auth.uid(), 'bank.statement_imported', 'bank_import', v_batch,
    jsonb_build_object('format', p_file_format, 'received', v_total, 'inserted', v_inserted, 'duplicates', v_total - v_inserted,
                       'taxInserted', v_tax_inserted)
  );

  RETURN jsonb_build_object(
    'status', 'imported',
    'batch_id', v_batch,
    'received', v_total,
    'inserted', v_inserted,
    'duplicates', v_total - v_inserted,
    'tax_inserted', v_tax_inserted
  );
END;
$$;

COMMENT ON FUNCTION public.import_bank_operations(text, jsonb) IS
  'Wgrywa z pliku z banku wpływy w złotych i (przy włączonym module księgowości) przelewy na rachunek składkowy ZUS '
  'i mikrorachunek firmy do payment_imports aktywnej firmy: najpierw sprawdza całą paczkę, duplikaty po kluczu pomija, '
  'audyt bez danych osób trzecich (00180, 00189).';

-- 4. Pominięcie: jak w 00180, ale potwierdzona zapłata rozliczenia najpierw wymaga „Cofnij”.
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
  IF v_op.tax_settlement_ids IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'tax_payment_confirmed');
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
    jsonb_build_object('amount', v_op.amount, 'bookingDate', COALESCE(v_op.booking_date, v_op.transaction_date), 'taxKind', v_op.tax_kind)
  );

  RETURN jsonb_build_object('status', 'skipped', 'operation_id', v_op.id);
END;
$$;

COMMENT ON FUNCTION public.skip_bank_operation(uuid) IS
  'Pomija operację z wyciągu i usuwa dane osób trzecich (tytuł, nazwa, rachunek, NIP, referencja); potwierdzona wpłata '
  'albo zapłata rozliczenia najpierw wymaga cofnięcia; audyt bez tych danych (00180, 00189).';

-- 5. Lista przelewów podatkowych dla ekranu „Bank”: do sprawdzenia (najwyżej 300), ostatnie
--    decyzje (50) i wszystkie potwierdzone zapłaty (jedno rozliczenie, jeden przelew). Czytają
--    wszyscy członkowie firmy; ekran pokazuje listę tylko przy włączonym module.
CREATE OR REPLACE FUNCTION public.bank_tax_operations()
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
               'tax_kind', p.tax_kind,
               'account', p.account_iban,
               'booking_date', COALESCE(p.booking_date, p.transaction_date),
               'amount', p.amount,
               'counterparty_name', p.counterparty_name,
               'counterparty_account', p.counterparty_account,
               'title', p.title
             ) ORDER BY p.transaction_date DESC, p.id)
        FROM (
          SELECT * FROM public.payment_imports
           WHERE tenant_id = v_tenant_id AND provider = 'bank_file' AND tax_kind IS NOT NULL
             AND NOT is_matched AND NOT ignored
           ORDER BY transaction_date DESC, id
           LIMIT 300
        ) AS p
    ), '[]'::jsonb),
    'pending_total', (
      SELECT count(*) FROM public.payment_imports
       WHERE tenant_id = v_tenant_id AND provider = 'bank_file' AND tax_kind IS NOT NULL AND NOT is_matched AND NOT ignored
    ),
    'decided', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', d.id,
               'tax_kind', d.tax_kind,
               'booking_date', COALESCE(d.booking_date, d.transaction_date),
               'amount', d.amount,
               'state', CASE WHEN d.ignored THEN 'skipped' ELSE 'confirmed' END,
               'decided_at', d.decided_at,
               'settlement_ids', to_jsonb(COALESCE(d.tax_settlement_ids, '{}'::uuid[])),
               'marked_ids', to_jsonb(COALESCE(d.tax_marked_ids, '{}'::uuid[])),
               'title', CASE WHEN d.ignored THEN NULL ELSE d.title END
             ) ORDER BY d.decided_at DESC, d.id)
        FROM (
          SELECT * FROM public.payment_imports
           WHERE tenant_id = v_tenant_id AND provider = 'bank_file' AND tax_kind IS NOT NULL
             AND decided_at IS NOT NULL AND (ignored OR tax_settlement_ids IS NOT NULL)
           ORDER BY decided_at DESC, id
           LIMIT 50
        ) AS d
    ), '[]'::jsonb),
    'links', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', l.id,
               'booking_date', COALESCE(l.booking_date, l.transaction_date),
               'settlement_ids', to_jsonb(l.tax_settlement_ids)
             ) ORDER BY l.id)
        FROM public.payment_imports AS l
       WHERE l.tenant_id = v_tenant_id AND l.provider = 'bank_file' AND l.tax_settlement_ids IS NOT NULL
    ), '[]'::jsonb)
  );
END;
$$;

COMMENT ON FUNCTION public.bank_tax_operations() IS
  'Przelewy do ZUS i urzędu z wyciągów aktywnej firmy: do sprawdzenia, ostatnie decyzje i potwierdzone zapłaty rozliczeń (00189).';

-- 6. Potwierdzenie przelewu jako zapłaty rozliczenia. Wynik: `confirmed`, `already_confirmed`
--    albo `refused` z `code`. Kolejność blokad: operacja, potem rozliczenia po id.
CREATE OR REPLACE FUNCTION public.confirm_bank_tax_payment(p_operation_id uuid, p_settlement_ids uuid[], p_match_kind text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  v_today date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
  v_op public.payment_imports%ROWTYPE;
  v_row public.tax_settlements%ROWTYPE;
  v_ids uuid[];
  v_count integer;
  v_okres date;
  v_paid_on date;
  v_marked uuid[] := '{}';
  v_sum bigint := 0;
  v_amount_gr bigint;
  v_linked_day date;
  v_rodzaje jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Tax payment confirmation requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  -- Jak polityka UPDATE `tax_settlements` (00168): zapłatę oznacza owner albo admin.
  IF NOT (public.has_org_role(v_tenant_id, 'owner') OR public.has_org_role(v_tenant_id, 'admin')) THEN
    RAISE EXCEPTION 'Insufficient role to confirm tax payment' USING ERRCODE = '42501';
  END IF;
  IF p_operation_id IS NULL OR p_settlement_ids IS NULL
     OR cardinality(p_settlement_ids) NOT BETWEEN 1 AND 2
     OR array_position(p_settlement_ids, NULL) IS NOT NULL
     OR p_match_kind IS NULL OR p_match_kind NOT IN ('title', 'amount', 'manual') THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_request');
  END IF;
  SELECT array_agg(DISTINCT x ORDER BY x) INTO v_ids FROM unnest(p_settlement_ids) AS x;
  IF cardinality(v_ids) <> cardinality(p_settlement_ids) THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_request');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenant_feature_flags AS f WHERE f.tenant_id = v_tenant_id AND f.ksiegowosc_enabled)
     OR EXISTS (SELECT 1 FROM public.global_feature_flags AS g WHERE g.flag = 'killKsiegowosc' AND g.enabled) THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'tax_module_disabled');
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
  IF v_op.tax_kind IS NULL OR v_op.amount >= 0 THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_tax_payment');
  END IF;
  v_paid_on := COALESCE(v_op.booking_date, v_op.transaction_date);
  IF v_op.tax_settlement_ids IS NOT NULL THEN
    IF v_op.tax_settlement_ids = v_ids THEN
      RETURN jsonb_build_object('status', 'already_confirmed', 'operation_id', v_op.id, 'tax_kind', v_op.tax_kind,
                                'settlement_ids', to_jsonb(v_ids), 'paid_on', v_paid_on);
    END IF;
    RETURN jsonb_build_object('status', 'refused', 'code', 'operation_confirmed');
  END IF;
  IF v_paid_on > v_today THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'payment_in_future', 'paid_on', v_paid_on);
  END IF;

  -- Rozliczenia w stałej kolejności (po id): dwa przelewy do tego samego rozliczenia czekają na siebie.
  PERFORM 1 FROM public.tax_settlements WHERE tenant_id = v_tenant_id AND id = ANY (v_ids) ORDER BY id FOR UPDATE;
  SELECT count(*), min(okres) INTO v_count, v_okres FROM public.tax_settlements WHERE tenant_id = v_tenant_id AND id = ANY (v_ids);
  IF v_count <> cardinality(v_ids) THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'settlement_not_found');
  END IF;
  -- Jeden okres, różne rodzaje; składki ZUS na rachunek składkowy, podatek (jeden) na mikrorachunek.
  IF (SELECT count(DISTINCT okres) FROM public.tax_settlements WHERE tenant_id = v_tenant_id AND id = ANY (v_ids)) <> 1
     OR (SELECT count(DISTINCT rodzaj) FROM public.tax_settlements WHERE tenant_id = v_tenant_id AND id = ANY (v_ids)) <> cardinality(v_ids)
     OR (v_op.tax_kind = 'zus' AND EXISTS (
           SELECT 1 FROM public.tax_settlements
            WHERE tenant_id = v_tenant_id AND id = ANY (v_ids) AND rodzaj NOT IN ('zus_spoleczne', 'zdrowotna')))
     OR (v_op.tax_kind = 'us' AND (cardinality(v_ids) <> 1 OR EXISTS (
           SELECT 1 FROM public.tax_settlements
            WHERE tenant_id = v_tenant_id AND id = ANY (v_ids) AND rodzaj NOT IN ('ryczalt', 'pit', 'vat')))) THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'settlement_kind');
  END IF;
  -- Tylko najnowsza wersja: po ponownym zatwierdzeniu starsza wersja nie przyjmuje zapłaty z wyciągu.
  IF EXISTS (
    SELECT 1 FROM public.tax_settlements AS s
     WHERE s.tenant_id = v_tenant_id AND s.id = ANY (v_ids)
       AND EXISTS (SELECT 1 FROM public.tax_settlements AS n
                    WHERE n.tenant_id = s.tenant_id AND n.okres = s.okres AND n.rodzaj = s.rodzaj AND n.wersja > s.wersja)
  ) THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'settlement_outdated', 'okres', to_char(v_okres, 'YYYY-MM'));
  END IF;
  -- CHECK tax_settlements_zaplata_od_okresu_check (00168): zapłata nie wcześniej niż rozliczany miesiąc.
  IF v_paid_on < v_okres THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'paid_before_period', 'okres', to_char(v_okres, 'YYYY-MM'), 'paid_on', v_paid_on);
  END IF;
  -- Jedno rozliczenie, jeden przelew z wyciągu.
  SELECT COALESCE(l.booking_date, l.transaction_date) INTO v_linked_day
    FROM public.payment_imports AS l
   WHERE l.tenant_id = v_tenant_id AND l.id <> v_op.id AND l.tax_settlement_ids && v_ids
   ORDER BY l.decided_at, l.id
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'settlement_linked', 'linked_on', v_linked_day);
  END IF;

  -- Zapłata tą samą drogą co „Zapłacone” w „Ten miesiąc”: status i dzień zapłaty (wyzwalacz 00168).
  -- Rozliczenie już zapłacone zostaje bez zmian: przelew dochodzi do niego jako dowód.
  FOR v_row IN SELECT * FROM public.tax_settlements WHERE tenant_id = v_tenant_id AND id = ANY (v_ids) ORDER BY id LOOP
    v_sum := v_sum + v_row.kwota_gr;
    IF v_row.status = 'zatwierdzone' THEN
      UPDATE public.tax_settlements
         SET status = 'zaplacone',
             zaplacone_o = v_paid_on
       WHERE id = v_row.id AND tenant_id = v_tenant_id;
      v_marked := v_marked || v_row.id;
      INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
      VALUES (
        v_tenant_id, auth.uid(), 'tax_settlement.paid', 'tax_settlement', v_row.id,
        jsonb_build_object('miesiac', to_char(v_row.okres, 'YYYY-MM'), 'rodzaj', v_row.rodzaj, 'wersja', v_row.wersja,
                           'kwotaGr', v_row.kwota_gr, 'zaplaconeO', v_paid_on, 'zrodlo', 'bank_import', 'operationId', v_op.id)
      );
    END IF;
  END LOOP;

  v_amount_gr := (-v_op.amount * 100)::bigint;
  SELECT jsonb_agg(rodzaj ORDER BY rodzaj) INTO v_rodzaje FROM public.tax_settlements WHERE tenant_id = v_tenant_id AND id = ANY (v_ids);

  UPDATE public.payment_imports
     SET is_matched = true,
         tax_settlement_ids = v_ids,
         tax_marked_ids = v_marked,
         decided_at = now(),
         decided_by = auth.uid()
   WHERE id = v_op.id AND tenant_id = v_tenant_id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_tenant_id, auth.uid(), 'bank.tax_payment_confirmed', 'bank_operation', v_op.id,
    jsonb_build_object('taxKind', v_op.tax_kind, 'okres', to_char(v_okres, 'YYYY-MM'), 'settlementIds', to_jsonb(v_ids),
                       'markedIds', to_jsonb(v_marked), 'matchKind', p_match_kind, 'paidOn', v_paid_on,
                       'bankAmountGr', v_amount_gr, 'computedGr', v_sum, 'differenceGr', v_amount_gr - v_sum)
  );

  RETURN jsonb_build_object(
    'status', 'confirmed',
    'operation_id', v_op.id,
    'tax_kind', v_op.tax_kind,
    'settlement_ids', to_jsonb(v_ids),
    'marked', cardinality(v_marked),
    'okres', to_char(v_okres, 'YYYY-MM'),
    'rodzaje', v_rodzaje,
    'paid_on', v_paid_on,
    'bank_amount_gr', v_amount_gr,
    'computed_gr', v_sum,
    'difference_gr', v_amount_gr - v_sum
  );
END;
$$;

COMMENT ON FUNCTION public.confirm_bank_tax_payment(uuid, uuid[], text) IS
  'Potwierdza przelew z wyciągu do ZUS albo urzędu jako zapłatę rozliczeń (najnowsze wersje, jeden okres): status zapłacone '
  'z dniem księgowania dla niezapłaconych, połączenie z operacją, audyt tax_settlement.paid i bank.tax_payment_confirmed, '
  'jedna transakcja (00189).';

-- 7. Cofnięcie potwierdzenia: rozliczenia oznaczone przez to potwierdzenie i niezmienione
--    od tego czasu wracają do „zatwierdzone”; zmienione zostają; operacja wraca do sprawdzenia.
CREATE OR REPLACE FUNCTION public.undo_bank_tax_payment(p_operation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  v_op public.payment_imports%ROWTYPE;
  v_row public.tax_settlements%ROWTYPE;
  v_paid_on date;
  v_reverted uuid[] := '{}';
  v_kept uuid[] := '{}';
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Tax payment change requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.has_org_role(v_tenant_id, 'owner') OR public.has_org_role(v_tenant_id, 'admin')) THEN
    RAISE EXCEPTION 'Insufficient role to undo tax payment' USING ERRCODE = '42501';
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
  IF v_op.tax_settlement_ids IS NULL THEN
    RETURN jsonb_build_object('status', 'not_confirmed', 'operation_id', v_op.id);
  END IF;
  v_paid_on := COALESCE(v_op.booking_date, v_op.transaction_date);

  PERFORM 1 FROM public.tax_settlements WHERE tenant_id = v_tenant_id AND id = ANY (v_op.tax_settlement_ids) ORDER BY id FOR UPDATE;
  FOR v_row IN SELECT * FROM public.tax_settlements WHERE tenant_id = v_tenant_id AND id = ANY (v_op.tax_marked_ids) ORDER BY id LOOP
    IF v_row.status = 'zaplacone' AND v_row.zaplacone_o = v_paid_on THEN
      UPDATE public.tax_settlements
         SET status = 'zatwierdzone',
             zaplacone_o = NULL
       WHERE id = v_row.id AND tenant_id = v_tenant_id;
      v_reverted := v_reverted || v_row.id;
      INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
      VALUES (
        v_tenant_id, auth.uid(), 'tax_settlement.unpaid', 'tax_settlement', v_row.id,
        jsonb_build_object('miesiac', to_char(v_row.okres, 'YYYY-MM'), 'rodzaj', v_row.rodzaj, 'wersja', v_row.wersja,
                           'kwotaGr', v_row.kwota_gr, 'zrodlo', 'bank_import', 'operationId', v_op.id)
      );
    ELSE
      v_kept := v_kept || v_row.id;
    END IF;
  END LOOP;

  UPDATE public.payment_imports
     SET is_matched = false,
         tax_settlement_ids = NULL,
         tax_marked_ids = NULL,
         decided_at = NULL,
         decided_by = NULL
   WHERE id = v_op.id AND tenant_id = v_tenant_id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_tenant_id, auth.uid(), 'bank.tax_payment_undone', 'bank_operation', v_op.id,
    jsonb_build_object('taxKind', v_op.tax_kind, 'settlementIds', to_jsonb(v_op.tax_settlement_ids),
                       'revertedIds', to_jsonb(v_reverted), 'keptIds', to_jsonb(v_kept), 'paidOn', v_paid_on,
                       'bankAmountGr', (-v_op.amount * 100)::bigint)
  );

  RETURN jsonb_build_object(
    'status', 'undone',
    'operation_id', v_op.id,
    'reverted', cardinality(v_reverted),
    'kept', cardinality(v_kept)
  );
END;
$$;

COMMENT ON FUNCTION public.undo_bank_tax_payment(uuid) IS
  'Cofa potwierdzenie zapłaty rozliczenia z wyciągu: oznaczone nim i niezmienione rozliczenia wracają do zatwierdzone, '
  'operacja do sprawdzenia; audyt tax_settlement.unpaid i bank.tax_payment_undone (00189).';

-- 8. Uprawnienia. Supabase nadaje EXECUTE rolom anon i authenticated jawnie, samo
--    FROM PUBLIC nic nie odbiera (AUD-30). Zastąpione funkcje dostają te same uprawnienia co w 00180.
REVOKE ALL ON FUNCTION public.import_bank_operations(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.import_bank_operations(text, jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.skip_bank_operation(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.skip_bank_operation(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.bank_tax_operations() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bank_tax_operations() TO authenticated;
REVOKE ALL ON FUNCTION public.confirm_bank_tax_payment(uuid, uuid[], text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.confirm_bank_tax_payment(uuid, uuid[], text) TO authenticated;
REVOKE ALL ON FUNCTION public.undo_bank_tax_payment(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.undo_bank_tax_payment(uuid) TO authenticated;
-- Funkcje wyzwalaczy nie są do wołania przez API.
REVOKE ALL ON FUNCTION public.guard_payment_import_update() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
