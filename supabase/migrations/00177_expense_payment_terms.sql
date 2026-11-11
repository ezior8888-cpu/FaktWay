-- ═══════════════════════════════════════════════════════════════
-- 00177: koszty do zapłaty (plan kompletnej aplikacji, krok 3.4, część 1;
-- projekt N7 z docs/koordynacja/PLAN-FINORA.md).
--
-- KIEDY WGRAĆ: PRZED wdrożeniem. Addytywna: pięć nowych kolumn NULL w
-- `expenses`, indeks częściowy, wyzwalacz i dwie nowe funkcje. Bez DROP tabel
-- i kolumn, bez zmiany istniejących danych (bez DML poza ciałami funkcji).
-- Stara wersja aplikacji nowych kolumn nie czyta ani nie zapisuje, więc baza
-- może wyprzedzać kod. Numer z rejestru: docs/koordynacja/CLAUDE-DO-CODEXA.md
-- (00174-00176 biorą równoległe PR #506, #524 i #510).
--
-- Co zapisujemy przy koszcie z KSeF (z pliku FA(3) w archiwum firmy, zadanie
-- `auto-categorize-inbox`, klucz serwisowy):
--   payment_due_date  najwcześniejszy `Platnosc/TerminPlatnosci/Termin`,
--   payment_account   pierwszy `Platnosc/RachunekBankowy/NrRB` (bez spacji),
--   payment_split     `Adnotacje/P_18A`: true = MPP, false = bez MPP,
--                     NULL = plik nie mówi albo pola nie dało się odczytać,
--   payment_terms     pozostałe fakty z pliku (rachunek faktora, zapłata
--                     częściowa, opis terminu, problemy odczytu) i chwila odczytu;
--                     NULL = plików nie odczytano (np. koszty sprzed tej migracji),
--   paid_at           dzień zapłaty: z pliku (`Zaplacono` + `DataZaplaty`) albo
--                     z „Oznacz jako zapłacone”; NULL = niezapłacony.
--
-- Uprawnienia: tabela ma grant na poziomie tabeli (00034: SELECT, UPDATE,
-- DELETE dla `authenticated`, INSERT odebrany w 00127), więc nowe kolumny
-- czyta lista „Do zapłaty” bez osobnego GRANT. Zapis z sesji blokuje wyzwalacz
-- `a_guard_expense_payment`: kolumny płatności zmienia tylko serwer (klucz
-- serwisowy w zadaniu) i dwa RPC niżej, które w tej samej transakcji dopisują
-- wiersz do `audit_logs` (`expense.marked_paid`, `expense.paid_undone`).
-- Koszty z KSeF i tak są dla sesji tylko do odczytu (00128).
--
-- Kto oznacza zapłatę: właściciel, administrator, członek firmy (jak
-- `mark_invoice_paid` z 00158). Księgowa ma wgląd.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS payment_due_date DATE,
  ADD COLUMN IF NOT EXISTS payment_account TEXT,
  ADD COLUMN IF NOT EXISTS payment_split BOOLEAN,
  ADD COLUMN IF NOT EXISTS payment_terms JSONB,
  ADD COLUMN IF NOT EXISTS paid_at DATE;

-- DROP CONSTRAINT IF EXISTS tylko dla nowych CHECK-ów, żeby migrację dało się powtórzyć.
ALTER TABLE public.expenses DROP CONSTRAINT IF EXISTS expenses_payment_terms_object_check;
ALTER TABLE public.expenses ADD CONSTRAINT expenses_payment_terms_object_check
  CHECK (payment_terms IS NULL OR jsonb_typeof(payment_terms) = 'object');

ALTER TABLE public.expenses DROP CONSTRAINT IF EXISTS expenses_paid_at_check;
ALTER TABLE public.expenses ADD CONSTRAINT expenses_paid_at_check
  CHECK (paid_at IS NULL OR paid_at >= DATE '2000-01-01');

COMMENT ON COLUMN public.expenses.payment_due_date IS
  'Termin płatności z FA(3) (najwcześniejszy Platnosc/TerminPlatnosci/Termin). NULL = faktura nie podaje daty albo pliku nie odczytano.';
COMMENT ON COLUMN public.expenses.payment_account IS
  'Rachunek sprzedawcy z FA(3) (pierwszy Platnosc/RachunekBankowy/NrRB, bez spacji, wielkie litery).';
COMMENT ON COLUMN public.expenses.payment_split IS
  'MPP z FA(3) (Adnotacje/P_18A): true = podzielona płatność, false = bez, NULL = nieznane.';
COMMENT ON COLUMN public.expenses.payment_terms IS
  'Pozostałe fakty o płatności z FA(3) i chwila odczytu (lib/expenses/platnosc-kosztu.ts). NULL = pliku nie odczytano.';
COMMENT ON COLUMN public.expenses.paid_at IS
  'Dzień zapłaty kosztu (z FA(3) albo z mark_expense_paid). NULL = niezapłacony.';

-- Lista „Do zapłaty”: niezapłacone koszty z terminem, od najbliższego terminu.
CREATE INDEX IF NOT EXISTS idx_expenses_do_zaplaty
  ON public.expenses (tenant_id, payment_due_date)
  WHERE paid_at IS NULL AND payment_due_date IS NOT NULL;

-- Sesja nie zmienia kolumn płatności bezpośrednio (także przy zwykłym koszcie
-- ze zdjęcia, który poza tym edytuje): bez tego zapłata ominęłaby audyt.
-- Funkcje SECURITY DEFINER niżej działają jako właściciel, zadanie jako
-- service_role, więc ten warunek ich nie dotyczy.
CREATE OR REPLACE FUNCTION public.guard_expense_payment_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon')
     AND (NEW.payment_due_date IS DISTINCT FROM OLD.payment_due_date
          OR NEW.payment_account IS DISTINCT FROM OLD.payment_account
          OR NEW.payment_split IS DISTINCT FROM OLD.payment_split
          OR NEW.payment_terms IS DISTINCT FROM OLD.payment_terms
          OR NEW.paid_at IS DISTINCT FROM OLD.paid_at) THEN
    RAISE EXCEPTION 'Expense payment fields are server-managed'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_guard_expense_payment ON public.expenses;
CREATE TRIGGER a_guard_expense_payment
  BEFORE UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.guard_expense_payment_columns();

-- Jak `guard_expense_provenance` (00123): funkcji wyzwalacza nikt nie woła wprost.
REVOKE ALL ON FUNCTION public.guard_expense_payment_columns() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.guard_expense_payment_columns() IS
  'Kolumny płatności kosztu zmienia tylko serwer i RPC mark_expense_paid / undo_expense_paid (z audytem).';

-- Oznaczenie zapłaty kosztu. Idempotentne: drugie wywołanie przy zapłaconym
-- koszcie zwraca `already_paid` bez zapisu i bez drugiego wpisu audytu.
CREATE OR REPLACE FUNCTION public.mark_expense_paid(
  p_expense_id uuid,
  p_paid_on date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  -- Dzień w Polsce, nie w strefie serwera: po północy UTC w Warszawie jest już jutro.
  v_today date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
  v_paid_on date;
  v_expense public.expenses%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR p_expense_id IS NULL THEN
    RAISE EXCEPTION 'Expense payment change requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.has_org_role(v_tenant_id, 'owner')
          OR public.has_org_role(v_tenant_id, 'admin')
          OR public.has_org_role(v_tenant_id, 'member')) THEN
    RAISE EXCEPTION 'Insufficient role to change expense payment' USING ERRCODE = '42501';
  END IF;

  -- Blokada wiersza: dwa dotknięcia naraz idą po kolei, drugie widzi zapłatę.
  SELECT * INTO v_expense
    FROM public.expenses
   WHERE id = p_expense_id AND tenant_id = v_tenant_id
   FOR UPDATE;
  -- Koszt obcej firmy wygląda jak brak kosztu.
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_found');
  END IF;

  v_paid_on := COALESCE(p_paid_on, v_today);
  IF v_paid_on > v_today THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'future_date', 'document_number', v_expense.document_number);
  END IF;
  -- Literówka w roku w polu daty (0202 zamiast 2026) nie jest datą zapłaty.
  IF v_paid_on < DATE '2000-01-01' THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_date', 'document_number', v_expense.document_number);
  END IF;

  IF v_expense.paid_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'already_paid',
      'paid_on', v_expense.paid_at,
      'document_number', v_expense.document_number
    );
  END IF;

  -- Korekta na minus: to sprzedawca oddaje pieniądze, nikt tu nic nie płaci.
  IF v_expense.gross_amount IS NULL OR v_expense.gross_amount <= 0 THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'nothing_to_pay', 'document_number', v_expense.document_number);
  END IF;

  UPDATE public.expenses
     SET paid_at = v_paid_on
   WHERE id = p_expense_id AND tenant_id = v_tenant_id AND paid_at IS NULL;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_tenant_id, auth.uid(), 'expense.marked_paid', 'expense', p_expense_id,
    jsonb_build_object(
      'paidOn', v_paid_on,
      'customDate', p_paid_on IS NOT NULL,
      'amount', v_expense.gross_amount,
      'dueDate', v_expense.payment_due_date
    )
  );

  RETURN jsonb_build_object(
    'status', 'marked',
    'paid_on', v_paid_on,
    'document_number', v_expense.document_number
  );
END;
$$;

COMMENT ON FUNCTION public.mark_expense_paid(uuid, date) IS
  'Oznacza koszt jako zapłacony w wybranym dniu (domyślnie dziś w Warszawie, nie z przyszłości) '
  'z wpisem audytu expense.marked_paid w tej samej transakcji. Idempotentne.';

-- Cofnięcie zapłaty kosztu. Idempotentne: przy niezapłaconym koszcie
-- `nothing_to_undo` bez zapisu.
CREATE OR REPLACE FUNCTION public.undo_expense_paid(p_expense_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  v_expense public.expenses%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR p_expense_id IS NULL THEN
    RAISE EXCEPTION 'Expense payment change requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.has_org_role(v_tenant_id, 'owner')
          OR public.has_org_role(v_tenant_id, 'admin')
          OR public.has_org_role(v_tenant_id, 'member')) THEN
    RAISE EXCEPTION 'Insufficient role to change expense payment' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_expense
    FROM public.expenses
   WHERE id = p_expense_id AND tenant_id = v_tenant_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_found');
  END IF;

  IF v_expense.paid_at IS NULL THEN
    RETURN jsonb_build_object('status', 'nothing_to_undo', 'document_number', v_expense.document_number);
  END IF;

  UPDATE public.expenses
     SET paid_at = NULL
   WHERE id = p_expense_id AND tenant_id = v_tenant_id AND paid_at IS NOT NULL;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_tenant_id, auth.uid(), 'expense.paid_undone', 'expense', p_expense_id,
    jsonb_build_object('paidOn', v_expense.paid_at, 'amount', v_expense.gross_amount)
  );

  RETURN jsonb_build_object(
    'status', 'undone',
    'paid_on', v_expense.paid_at,
    'document_number', v_expense.document_number
  );
END;
$$;

COMMENT ON FUNCTION public.undo_expense_paid(uuid) IS
  'Cofa zapłatę kosztu (paid_at = NULL) z wpisem audytu expense.paid_undone w tej samej transakcji. Idempotentne.';

REVOKE ALL ON FUNCTION public.mark_expense_paid(uuid, date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_expense_paid(uuid, date) TO authenticated;
REVOKE ALL ON FUNCTION public.undo_expense_paid(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.undo_expense_paid(uuid) TO authenticated;

-- PostgREST na serwerze trzyma schemat w pamięci: nowe kolumny i funkcje
-- muszą być widoczne, zanim ruszy wersja aplikacji, która ich używa.
NOTIFY pgrst, 'reload schema';
