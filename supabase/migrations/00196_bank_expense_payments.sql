-- ═══════════════════════════════════════════════════════════════
-- 00196: przelewy do dostawców z wyciągu jako zapłaty kosztów z listy
-- „Do zapłaty” (plan kompletnej aplikacji, krok 3.2, część 3; lista i ręczne
-- „Oznacz jako zapłacone” z kroku 3.4, migracja 00177).
--
-- RODO (jak 00180, a dla wypływów ostrzej): przelewu do dostawcy nie
-- zapisujemy przy wgraniu wyciągu. Propozycje liczy akcja z pliku i pokazuje je
-- klientowi bez zapisu. Do `payment_imports` wypływ trafia dopiero po decyzji:
--   - „Potwierdź” albo wybór kosztów (`confirm_bank_expense_payment`):
--     operacja z danymi z banku jako dowód zapłaty, połączona z kosztami
--     (`expense_ids`);
--   - „Pomiń” (`skip_bank_expense_operation`): od razu bez danych osób
--     trzecich (bez tytułu, nazwy, rachunku, NIP i referencji); zostają
--     kwota, dzień, rachunek firmy i klucz duplikatu, żeby przelew nie wrócił
--     przy kolejnym wgraniu. Tylko dla przelewu na rachunek z kosztów firmy.
-- CHECK `payment_imports_bank_file_direction_check` pilnuje tego także dla
-- klucza serwisowego: wypływ bez rodzaju podatkowego istnieje tylko jako
-- potwierdzona zapłata kosztów albo pominięty bez danych. „Cofnij”
-- (`undo_bank_expense_payment`) oddaje kosztom stan niezapłacony i usuwa
-- operację (niepotwierdzony wypływ nie zostaje w bazie); ślad zostaje w audycie.
--
-- Zapłata tą samą drogą co „Oznacz jako zapłacone” z 00177: `mark_expense_paid`
-- z dniem księgowania z wyciągu (audyt `expense.marked_paid`), cofnięcie przez
-- `undo_expense_paid` (audyt `expense.paid_undone`), w jednej transakcji
-- z operacją z wyciągu i wpisem `bank.expense_payment_*`. Baza sprawdza granice
-- drugi raz: firma i rola z sesji (owner, admin, member jak 00177; księgowa
-- tylko czyta), koszty niezapłacone, dodatnie i w złotych, rachunek odbiorcy
-- równy rachunkowi z faktury każdego kosztu (z „PL” albo bez), kwota przelewu
-- równa sumie kwot do zapłaty (brutto bez wpłat częściowych z faktury, jak lista
-- „Do zapłaty”), dzień księgowania nie z przyszłości.
--
-- ZMIANA CHECK: `payment_imports_bank_file_direction_check` z 00189 (wypływ
-- z pliku tylko jako przelew podatkowy) dostaje wypływ do dostawcy w dwóch
-- postaciach z akapitu wyżej. DROP CONSTRAINT IF EXISTS i ADD CONSTRAINT z tą
-- samą nazwą w jednej instrukcji (jak 00192 z CHECK-iem z 00188); dawne gałęzie
-- bez zmiany sensu, istniejące wiersze mają `expense_ids` NULL i spełniają nowy
-- warunek. Zastąpione z tą samą sygnaturą, z całym zachowaniem z 00189 i jedną
-- nową gałęzią: `skip_bank_operation` (odmowa `expense_payment_confirmed`)
-- i funkcja wyzwalacza `guard_payment_import_update` (`expense_ids` niezmienne).
-- `import_bank_operations` bez zmian: wypływ bez rodzaju podatkowego dalej jest
-- tam odmową.
--
-- Kontrola przed wgraniem (oczekiwane 0):
--   SELECT count(*) FROM public.payment_imports
--    WHERE provider = 'bank_file' AND amount < 0 AND tax_kind IS NULL;
--
-- KIEDY WGRAĆ: PRZED wdrożeniem, po 00189 (#590) i 00177 (#531). Addytywna:
-- nowa kolumna NULL, zastąpiony CHECK (szerszy o zapłaty kosztów), nowy CHECK,
-- zastąpione funkcje z tą samą sygnaturą i nowe funkcje. Stara wersja aplikacji
-- nowych funkcji nie woła. Bez DROP tabel i kolumn, bez TRUNCATE, bez zmiany
-- danych przy wgraniu; INSERT, UPDATE i DELETE tylko w ciałach funkcji, na
-- żądanie klienta. Rejestr numerów: docs/koordynacja/CLAUDE-DO-CODEXA.md.
-- ═══════════════════════════════════════════════════════════════

-- 1. Koszty zapłacone przelewem.
ALTER TABLE public.payment_imports
  ADD COLUMN IF NOT EXISTS expense_ids uuid[];

COMMENT ON COLUMN public.payment_imports.expense_ids IS
  'Koszty (expenses) zapłacone tym przelewem z wyciągu po „Potwierdź” (00196), rosnąco; NULL przy innych operacjach. Niezmienne.';

-- Wpływ bez rodzaju; wypływ jako przelew podatkowy (00189) albo do dostawcy: rozstrzygnięty,
-- połączony z kosztami albo pominięty i bez danych osób trzecich. Niepotwierdzony wypływ nie istnieje.
ALTER TABLE public.payment_imports
  DROP CONSTRAINT IF EXISTS payment_imports_bank_file_direction_check,
  ADD CONSTRAINT payment_imports_bank_file_direction_check
  CHECK (
    provider <> 'bank_file'
    OR (amount > 0 AND tax_kind IS NULL AND expense_ids IS NULL)
    OR (amount < 0 AND tax_kind IS NOT NULL AND expense_ids IS NULL)
    OR (amount < 0 AND tax_kind IS NULL AND decided_at IS NOT NULL
        AND ((expense_ids IS NOT NULL AND is_matched AND NOT ignored)
             OR (expense_ids IS NULL AND ignored AND NOT is_matched AND redacted_at IS NOT NULL)))
  );

-- Połączenie z kosztami: 1-500 kosztów (tyle obejmuje identyfikator zbiorczy), nigdy razem
-- z wpłatą do faktury ani zapłatą rozliczenia, operacja rozstrzygnięta i z danymi z banku.
ALTER TABLE public.payment_imports DROP CONSTRAINT IF EXISTS payment_imports_expense_link_check;
ALTER TABLE public.payment_imports ADD CONSTRAINT payment_imports_expense_link_check
  CHECK (
    expense_ids IS NULL
    OR (cardinality(expense_ids) BETWEEN 1 AND 500
        AND array_position(expense_ids, NULL) IS NULL
        AND amount < 0 AND tax_kind IS NULL AND matched_payment_id IS NULL AND tax_settlement_ids IS NULL
        AND is_matched AND NOT ignored AND decided_at IS NOT NULL AND redacted_at IS NULL)
  );

-- 2. Połączenie z kosztami jest dowodem jak kwota i rachunek: wyzwalacz z 00189 dostaje `expense_ids`.
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
     OR NEW.tax_kind IS DISTINCT FROM OLD.tax_kind
     OR NEW.expense_ids IS DISTINCT FROM OLD.expense_ids THEN
    RAISE EXCEPTION 'Bank operation evidence is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.redacted_at IS NOT NULL AND NEW.redacted_at IS DISTINCT FROM OLD.redacted_at THEN
    RAISE EXCEPTION 'Redacted bank operation stays redacted' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- 3. Rachunek do porównań: bez spacji i znaków rozdzielających, wielkie litery, polski rachunek
--    bez „PL” (26 cyfr), zagraniczny IBAN bez zmian. Ta sama zasada co `rachunekZnormalizowany`
--    w lib/import/bank/rachunek.ts. Tylko dla funkcji niżej, bez EXECUTE dla klientów.
CREATE OR REPLACE FUNCTION public.bank_account_key(p_account text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
           WHEN upper(regexp_replace(COALESCE(p_account, ''), '[^A-Za-z0-9]', '', 'g')) ~ '^PL[0-9]{26}$'
             THEN substr(upper(regexp_replace(COALESCE(p_account, ''), '[^A-Za-z0-9]', '', 'g')), 3)
           ELSE upper(regexp_replace(COALESCE(p_account, ''), '[^A-Za-z0-9]', '', 'g'))
         END
$$;

COMMENT ON FUNCTION public.bank_account_key(text) IS
  'Rachunek do porównań przelewu z kosztem (00196): bez znaków rozdzielających, polski bez PL. Bez EXECUTE dla klientów.';

-- 4. Które operacje z pliku są już w bazie (potwierdzone albo pominięte): akcja nie pokazuje
--    ich drugi raz. Czytają wszyscy członkowie firmy; klucze to skróty SHA-256.
CREATE OR REPLACE FUNCTION public.bank_known_operations(p_keys text[])
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
  -- Ta sama granica co MAX_BANK_OPERATIONS w `lib/import/bank/ekran.ts`.
  IF p_keys IS NULL OR cardinality(p_keys) > 2000 THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_request');
  END IF;
  RETURN jsonb_build_object(
    'status', 'ok',
    'known', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'key', p.transaction_id,
               'state', CASE WHEN p.expense_ids IS NOT NULL THEN 'confirmed'
                             WHEN p.ignored THEN 'skipped'
                             ELSE 'other' END
             ) ORDER BY p.transaction_id)
        FROM public.payment_imports AS p
       WHERE p.tenant_id = v_tenant_id AND p.provider = 'bank_file' AND p.transaction_id = ANY (p_keys)
    ), '[]'::jsonb)
  );
END;
$$;

COMMENT ON FUNCTION public.bank_known_operations(text[]) IS
  'Klucze operacji z wyciągu, które aktywna firma już ma (potwierdzone, pominięte, inne), bez danych operacji (00196).';

-- 5. Potwierdzenie przelewu jako zapłaty kosztów. Wynik: `confirmed`, `already_confirmed`
--    albo `refused` z `code`. Kolejność blokad: klucz operacji, operacja, koszty po id.
CREATE OR REPLACE FUNCTION public.confirm_bank_expense_payment(
  p_file_format text,
  p_operation jsonb,
  p_expense_ids uuid[],
  p_match_kind text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  -- Dzień w Polsce, nie w strefie serwera.
  v_today date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
  v_key text;
  v_day date;
  v_amount numeric;
  v_account text;
  v_ids uuid[];
  v_id uuid;
  v_existing public.payment_imports%ROWTYPE;
  v_exp public.expenses%ROWTYPE;
  v_currency text;
  v_partial numeric;
  v_due numeric;
  v_sum numeric := 0;
  v_documents jsonb := '[]'::jsonb;
  v_result jsonb;
  v_op_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Expense payment from bank requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  -- Jak `mark_expense_paid` (00177): zapłatę kosztu oznacza owner, admin albo member; księgowa ma wgląd.
  IF NOT (public.has_org_role(v_tenant_id, 'owner')
          OR public.has_org_role(v_tenant_id, 'admin')
          OR public.has_org_role(v_tenant_id, 'member')) THEN
    RAISE EXCEPTION 'Insufficient role to confirm expense payment' USING ERRCODE = '42501';
  END IF;
  IF p_file_format IS NULL OR p_file_format NOT IN ('mt940', 'camt053', 'csv_pko_elixir')
     OR p_operation IS NULL OR jsonb_typeof(p_operation) <> 'object'
     OR p_expense_ids IS NULL OR cardinality(p_expense_ids) NOT BETWEEN 1 AND 500
     OR array_position(p_expense_ids, NULL) IS NOT NULL
     OR p_match_kind IS NULL OR p_match_kind NOT IN ('ksef_number', 'collective_identifier', 'invoice_number', 'amount', 'manual') THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_request');
  END IF;
  SELECT array_agg(DISTINCT x ORDER BY x) INTO v_ids FROM unnest(p_expense_ids) AS x;
  IF cardinality(v_ids) <> cardinality(p_expense_ids) THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_request');
  END IF;

  -- Operacja jak w `import_bank_operations` (00180), ale tylko wypływ w złotych z groszami.
  IF NOT (COALESCE(p_operation ->> 'key', '') ~ '^v1:[0-9a-f]{64}$')
     OR NOT (COALESCE(p_operation ->> 'account', '') ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{8,30}$')
     OR NOT (COALESCE(p_operation ->> 'amount', '') ~ '^-[0-9]{1,13}(\.[0-9]{1,2})?$')
     OR NOT (COALESCE(p_operation ->> 'booking_date', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
     OR COALESCE(p_operation ->> 'currency', '') <> 'PLN'
     OR char_length(COALESCE(p_operation ->> 'title', '')) > 1000
     OR char_length(COALESCE(p_operation ->> 'counterparty_name', '')) > 500
     OR char_length(COALESCE(p_operation ->> 'counterparty_account', '')) > 64
     OR char_length(COALESCE(p_operation ->> 'reference', '')) > 100 THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_operation');
  END IF;
  BEGIN
    v_day := (p_operation ->> 'booking_date')::date;
  EXCEPTION WHEN others THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_operation');
  END;
  v_amount := (p_operation ->> 'amount')::numeric;
  IF v_amount >= 0 OR v_day < DATE '2000-01-01' THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_operation');
  END IF;
  v_account := public.bank_account_key(p_operation ->> 'counterparty_account');
  IF v_account = '' THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_expense_payment');
  END IF;
  v_key := p_operation ->> 'key';

  -- Dwa potwierdzenia tego samego przelewu naraz (dwie karty, ponowienie) idą po kolei.
  PERFORM pg_advisory_xact_lock(hashtextextended('bank_expense:' || v_tenant_id::text || ':' || v_key, 0));
  SELECT * INTO v_existing
    FROM public.payment_imports
   WHERE tenant_id = v_tenant_id AND provider = 'bank_file' AND transaction_id = v_key
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing.expense_ids IS NOT NULL THEN
      IF v_existing.expense_ids = v_ids THEN
        RETURN jsonb_build_object('status', 'already_confirmed', 'operation_id', v_existing.id, 'expense_ids', to_jsonb(v_ids),
                                  'paid_on', COALESCE(v_existing.booking_date, v_existing.transaction_date));
      END IF;
      RETURN jsonb_build_object('status', 'refused', 'code', 'operation_confirmed');
    END IF;
    IF v_existing.ignored THEN
      RETURN jsonb_build_object('status', 'refused', 'code', 'operation_skipped');
    END IF;
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_expense_payment');
  END IF;
  -- Jak `mark_expense_paid`: zapłata nie z przyszłości (dzień w Warszawie).
  IF v_day > v_today THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'payment_in_future', 'paid_on', v_day);
  END IF;

  -- Koszty w stałej kolejności (po id): dwa przelewy do tego samego kosztu czekają na siebie.
  PERFORM 1 FROM public.expenses WHERE tenant_id = v_tenant_id AND id = ANY (v_ids) ORDER BY id FOR UPDATE;
  -- Koszt obcej firmy wygląda jak brak kosztu.
  IF (SELECT count(*) FROM public.expenses WHERE tenant_id = v_tenant_id AND id = ANY (v_ids)) <> cardinality(v_ids) THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'expense_not_found');
  END IF;
  FOR v_exp IN SELECT * FROM public.expenses WHERE tenant_id = v_tenant_id AND id = ANY (v_ids) ORDER BY id LOOP
    IF v_exp.paid_at IS NOT NULL THEN
      RETURN jsonb_build_object('status', 'refused', 'code', 'expense_paid', 'document_number', v_exp.document_number, 'paid_on', v_exp.paid_at);
    END IF;
    -- Korekta na minus: to sprzedawca oddaje pieniądze (jak `nothing_to_pay` w 00177).
    IF v_exp.gross_amount IS NULL OR v_exp.gross_amount <= 0 THEN
      RETURN jsonb_build_object('status', 'refused', 'code', 'nothing_to_pay', 'document_number', v_exp.document_number);
    END IF;
    -- Koszt z faktury KSeF: tylko w złotych, jak lista „Do zapłaty”.
    IF v_exp.ksef_invoice_id IS NOT NULL THEN
      SELECT upper(btrim(i.currency)) INTO v_currency
        FROM public.invoices AS i
       WHERE i.id = v_exp.ksef_invoice_id AND i.tenant_id = v_tenant_id;
      IF v_currency IS DISTINCT FROM 'PLN' THEN
        RETURN jsonb_build_object('status', 'refused', 'code', 'expense_currency', 'document_number', v_exp.document_number);
      END IF;
    END IF;
    IF public.bank_account_key(v_exp.payment_account) = '' OR public.bank_account_key(v_exp.payment_account) <> v_account THEN
      RETURN jsonb_build_object('status', 'refused', 'code', 'account_mismatch', 'document_number', v_exp.document_number);
    END IF;
    -- Do zapłaty jak na liście „Do zapłaty” (lib/expenses/do-zaplaty.ts): brutto bez wpłat częściowych z faktury.
    v_partial := CASE WHEN jsonb_typeof(v_exp.payment_terms -> 'zaplaconoCzesciowo') = 'number'
                      THEN (v_exp.payment_terms ->> 'zaplaconoCzesciowo')::numeric END;
    v_due := CASE WHEN v_partial > 0 AND v_partial < v_exp.gross_amount
                  THEN round(v_exp.gross_amount - v_partial, 2)
                  ELSE v_exp.gross_amount END;
    v_sum := v_sum + v_due;
    v_documents := v_documents || jsonb_build_array(jsonb_build_object(
      'id', v_exp.id, 'document_number', v_exp.document_number, 'seller_name', v_exp.seller_name));
  END LOOP;
  IF v_sum <> -v_amount THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'amount_mismatch',
                              'due_gr', (v_sum * 100)::bigint, 'amount_gr', (-v_amount * 100)::bigint,
                              'document_number', CASE WHEN cardinality(v_ids) = 1 THEN v_documents -> 0 ->> 'document_number' END);
  END IF;

  -- Zapłata tą samą drogą co „Oznacz jako zapłacone” (00177), z dniem księgowania z wyciągu.
  -- Granice sprawdzone wyżej pod blokadą, więc inny wynik niż `marked` to błąd: cała transakcja się cofa.
  FOREACH v_id IN ARRAY v_ids LOOP
    v_result := public.mark_expense_paid(v_id, v_day);
    IF COALESCE(v_result ->> 'status', '') <> 'marked' THEN
      RAISE EXCEPTION 'mark_expense_paid returned %', COALESCE(v_result ->> 'status', 'null') USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  INSERT INTO public.payment_imports (
    tenant_id, provider, account_iban, account_currency, transaction_id, transaction_date, booking_date,
    amount, currency, counterparty_name, counterparty_account, title, reference,
    file_format, import_batch_id, imported_by, is_matched, expense_ids, decided_at, decided_by
  )
  VALUES (
    v_tenant_id, 'bank_file', p_operation ->> 'account', 'PLN', v_key, v_day, v_day,
    v_amount, 'PLN',
    NULLIF(btrim(p_operation ->> 'counterparty_name'), ''), NULLIF(btrim(p_operation ->> 'counterparty_account'), ''),
    NULLIF(btrim(p_operation ->> 'title'), ''), NULLIF(btrim(p_operation ->> 'reference'), ''),
    p_file_format, gen_random_uuid(), auth.uid(), true, v_ids, now(), auth.uid()
  )
  RETURNING id INTO v_op_id;

  -- Audyt bez danych osób trzecich: koszty, kwota, dzień, rodzaj dopasowania.
  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_tenant_id, auth.uid(), 'bank.expense_payment_confirmed', 'bank_operation', v_op_id,
    jsonb_build_object('expenseIds', to_jsonb(v_ids), 'matchKind', p_match_kind, 'paidOn', v_day,
                       'amountGr', (-v_amount * 100)::bigint, 'count', cardinality(v_ids))
  );

  RETURN jsonb_build_object(
    'status', 'confirmed',
    'operation_id', v_op_id,
    'expense_ids', to_jsonb(v_ids),
    'paid_on', v_day,
    'amount_gr', (-v_amount * 100)::bigint,
    'match_kind', p_match_kind,
    'documents', v_documents
  );
END;
$$;

COMMENT ON FUNCTION public.confirm_bank_expense_payment(text, jsonb, uuid[], text) IS
  'Zapisuje przelew z wyciągu jako zapłatę kosztów z listy Do zapłaty: rachunek z faktury, kwota równa sumie do zapłaty, '
  'mark_expense_paid (00177) z dniem księgowania, operacja jako dowód, audyt bank.expense_payment_confirmed, jedna transakcja (00196).';

-- 6. Pominięcie przelewu do dostawcy: znacznik od razu bez danych osób trzecich.
CREATE OR REPLACE FUNCTION public.skip_bank_expense_operation(p_file_format text, p_operation jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  v_today date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
  v_key text;
  v_day date;
  v_amount numeric;
  v_account text;
  v_existing public.payment_imports%ROWTYPE;
  v_op_id uuid;
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
  IF p_file_format IS NULL OR p_file_format NOT IN ('mt940', 'camt053', 'csv_pko_elixir')
     OR p_operation IS NULL OR jsonb_typeof(p_operation) <> 'object' THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_request');
  END IF;
  IF NOT (COALESCE(p_operation ->> 'key', '') ~ '^v1:[0-9a-f]{64}$')
     OR NOT (COALESCE(p_operation ->> 'account', '') ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{8,30}$')
     OR NOT (COALESCE(p_operation ->> 'amount', '') ~ '^-[0-9]{1,13}(\.[0-9]{1,2})?$')
     OR NOT (COALESCE(p_operation ->> 'booking_date', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
     OR COALESCE(p_operation ->> 'currency', '') <> 'PLN'
     OR char_length(COALESCE(p_operation ->> 'counterparty_account', '')) > 64 THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_operation');
  END IF;
  BEGIN
    v_day := (p_operation ->> 'booking_date')::date;
  EXCEPTION WHEN others THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_operation');
  END;
  v_amount := (p_operation ->> 'amount')::numeric;
  -- Jak przy wgraniu (00180): dzień nie z przyszłości (dzień zapasu na strefę banku) i nie sprzed 2000 r.
  IF v_amount >= 0 OR v_day < DATE '2000-01-01' OR v_day > v_today + 1 THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_operation');
  END IF;
  v_account := public.bank_account_key(p_operation ->> 'counterparty_account');
  -- Przelew, który nie trafia w rachunek żadnego kosztu firmy, nie zostawia w bazie nawet znacznika.
  IF v_account = '' OR NOT EXISTS (
    SELECT 1 FROM public.expenses AS e
     WHERE e.tenant_id = v_tenant_id AND e.payment_account IS NOT NULL
       AND public.bank_account_key(e.payment_account) = v_account
  ) THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_expense_payment');
  END IF;
  v_key := p_operation ->> 'key';

  PERFORM pg_advisory_xact_lock(hashtextextended('bank_expense:' || v_tenant_id::text || ':' || v_key, 0));
  SELECT * INTO v_existing
    FROM public.payment_imports
   WHERE tenant_id = v_tenant_id AND provider = 'bank_file' AND transaction_id = v_key
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing.expense_ids IS NOT NULL THEN
      RETURN jsonb_build_object('status', 'refused', 'code', 'operation_confirmed');
    END IF;
    IF v_existing.ignored THEN
      RETURN jsonb_build_object('status', 'already_skipped', 'operation_id', v_existing.id);
    END IF;
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_expense_payment');
  END IF;

  -- Bez tytułu, nazwy, rachunku i NIP odbiorcy i bez referencji: tych pól nie ma w tym INSERT.
  INSERT INTO public.payment_imports (
    tenant_id, provider, account_iban, account_currency, transaction_id, transaction_date, booking_date,
    amount, currency, file_format, import_batch_id, imported_by, ignored, decided_at, decided_by, redacted_at
  )
  VALUES (
    v_tenant_id, 'bank_file', p_operation ->> 'account', 'PLN', v_key, v_day, v_day,
    v_amount, 'PLN', p_file_format, gen_random_uuid(), auth.uid(), true, now(), auth.uid(), now()
  )
  RETURNING id INTO v_op_id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_tenant_id, auth.uid(), 'bank.operation_skipped', 'bank_operation', v_op_id,
    jsonb_build_object('amount', v_amount, 'bookingDate', v_day, 'expensePayment', true)
  );

  RETURN jsonb_build_object('status', 'skipped', 'operation_id', v_op_id);
END;
$$;

COMMENT ON FUNCTION public.skip_bank_expense_operation(text, jsonb) IS
  'Pomija przelew z wyciągu na rachunek z kosztów firmy: znacznik bez danych osób trzecich (kwota, dzień, rachunek firmy, '
  'klucz), żeby nie wrócił przy kolejnym wgraniu; audyt bank.operation_skipped (00196).';

-- 7. Cofnięcie: koszty oznaczone tym przelewem i niezmienione od tego czasu wracają do
--    niezapłaconych przez `undo_expense_paid` (00177); zmienione zostają. Operacja znika.
CREATE OR REPLACE FUNCTION public.undo_bank_expense_payment(p_operation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  v_op public.payment_imports%ROWTYPE;
  v_id uuid;
  v_paid date;
  v_number text;
  v_exists boolean;
  v_paid_on date;
  v_result jsonb;
  v_reverted uuid[] := '{}';
  v_kept uuid[] := '{}';
  v_kept_documents jsonb := '[]'::jsonb;
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
  -- Operacja obcej firmy (albo cofnięta wcześniej) wygląda jak brak operacji.
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'operation_not_found');
  END IF;
  IF v_op.expense_ids IS NULL THEN
    RETURN jsonb_build_object('status', 'not_confirmed', 'operation_id', v_op.id);
  END IF;
  v_paid_on := COALESCE(v_op.booking_date, v_op.transaction_date);

  PERFORM 1 FROM public.expenses WHERE tenant_id = v_tenant_id AND id = ANY (v_op.expense_ids) ORDER BY id FOR UPDATE;
  FOREACH v_id IN ARRAY v_op.expense_ids LOOP
    SELECT paid_at, document_number INTO v_paid, v_number
      FROM public.expenses
     WHERE id = v_id AND tenant_id = v_tenant_id;
    v_exists := FOUND;
    IF v_exists AND v_paid = v_paid_on THEN
      -- Ta sama droga co „Cofnij zapłatę” przy koszcie (00177), z audytem expense.paid_undone.
      v_result := public.undo_expense_paid(v_id);
      IF COALESCE(v_result ->> 'status', '') <> 'undone' THEN
        RAISE EXCEPTION 'undo_expense_paid returned %', COALESCE(v_result ->> 'status', 'null') USING ERRCODE = 'P0001';
      END IF;
      v_reverted := v_reverted || v_id;
    ELSE
      v_kept := v_kept || v_id;
      IF v_exists THEN
        v_kept_documents := v_kept_documents || jsonb_build_array(v_number);
      END IF;
    END IF;
  END LOOP;

  -- Niepotwierdzony wypływ nie zostaje w bazie (RODO, jak przy wgraniu): po cofnięciu ten sam
  -- przelew wróci jako propozycja przy kolejnym wgraniu wyciągu.
  DELETE FROM public.payment_imports WHERE id = v_op.id AND tenant_id = v_tenant_id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_tenant_id, auth.uid(), 'bank.expense_payment_undone', 'bank_operation', v_op.id,
    jsonb_build_object('expenseIds', to_jsonb(v_op.expense_ids), 'revertedIds', to_jsonb(v_reverted), 'keptIds', to_jsonb(v_kept),
                       'paidOn', v_paid_on, 'amountGr', (-v_op.amount * 100)::bigint)
  );

  RETURN jsonb_build_object(
    'status', 'undone',
    'operation_id', v_op.id,
    'expense_ids', to_jsonb(v_op.expense_ids),
    'reverted', cardinality(v_reverted),
    'kept', cardinality(v_kept),
    'kept_documents', v_kept_documents
  );
END;
$$;

COMMENT ON FUNCTION public.undo_bank_expense_payment(uuid) IS
  'Cofa zapłatę kosztów z przelewu z wyciągu: niezmienione koszty przez undo_expense_paid (00177), operacja usunięta, '
  'audyt bank.expense_payment_undone (00196).';

-- 8. Lista dla ekranu „Bank”: ostatnie decyzje o przelewach do dostawców (50) z kosztami
--    i ich stanem zapłaty. Czytają wszyscy członkowie firmy; pominięte bez danych.
CREATE OR REPLACE FUNCTION public.bank_expense_operations()
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
    'confirmed_total', (
      SELECT count(*) FROM public.payment_imports
       WHERE tenant_id = v_tenant_id AND provider = 'bank_file' AND expense_ids IS NOT NULL
    ),
    'decided', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', d.id,
               'booking_date', COALESCE(d.booking_date, d.transaction_date),
               'amount', d.amount,
               'state', CASE WHEN d.ignored THEN 'skipped' ELSE 'confirmed' END,
               'decided_at', d.decided_at,
               'counterparty_name', CASE WHEN d.ignored THEN NULL ELSE d.counterparty_name END,
               'title', CASE WHEN d.ignored THEN NULL ELSE d.title END,
               'expenses', COALESCE(x.expenses, '[]'::jsonb)
             ) ORDER BY d.decided_at DESC, d.id)
        FROM (
          SELECT * FROM public.payment_imports
           WHERE tenant_id = v_tenant_id AND provider = 'bank_file' AND amount < 0 AND tax_kind IS NULL
             AND decided_at IS NOT NULL
           ORDER BY decided_at DESC, id
           LIMIT 50
        ) AS d
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(jsonb_build_object(
                   'id', e.id, 'document_number', e.document_number, 'seller_name', e.seller_name, 'paid_at', e.paid_at
                 ) ORDER BY e.id) AS expenses
            FROM public.expenses AS e
           WHERE e.tenant_id = v_tenant_id AND e.id = ANY (d.expense_ids)
        ) AS x ON true
    ), '[]'::jsonb)
  );
END;
$$;

COMMENT ON FUNCTION public.bank_expense_operations() IS
  'Ostatnie decyzje o przelewach do dostawców z wyciągów aktywnej firmy: zapłaty kosztów z ich stanem i pominięte bez danych (00196).';

-- 9. Pominięcie (00180, 00189): całe dotychczasowe zachowanie, a potwierdzona zapłata kosztów
--    najpierw wymaga „Cofnij” (wiersz z kosztami nie może stać się pominiętym).
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
  IF v_op.expense_ids IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'expense_payment_confirmed');
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
  'Pomija operację z wyciągu i usuwa dane osób trzecich (tytuł, nazwa, rachunek, NIP, referencja); potwierdzona wpłata, '
  'zapłata rozliczenia albo zapłata kosztów najpierw wymaga cofnięcia; audyt bez tych danych (00180, 00189, 00196).';

-- 10. Uprawnienia. Supabase nadaje EXECUTE rolom anon i authenticated jawnie, samo
--     FROM PUBLIC nic nie odbiera (AUD-30). Tylko sesja zalogowanego: firma i autor z sesji.
REVOKE ALL ON FUNCTION public.bank_known_operations(text[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bank_known_operations(text[]) TO authenticated;
REVOKE ALL ON FUNCTION public.confirm_bank_expense_payment(text, jsonb, uuid[], text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.confirm_bank_expense_payment(text, jsonb, uuid[], text) TO authenticated;
REVOKE ALL ON FUNCTION public.skip_bank_expense_operation(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.skip_bank_expense_operation(text, jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.undo_bank_expense_payment(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.undo_bank_expense_payment(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.bank_expense_operations() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bank_expense_operations() TO authenticated;
-- Zastąpiona funkcja dostaje te same uprawnienia co w 00180 i 00189.
REVOKE ALL ON FUNCTION public.skip_bank_operation(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.skip_bank_operation(uuid) TO authenticated;
-- Funkcja pomocnicza i funkcja wyzwalacza nie są do wołania przez API.
REVOKE ALL ON FUNCTION public.bank_account_key(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_payment_import_update() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
