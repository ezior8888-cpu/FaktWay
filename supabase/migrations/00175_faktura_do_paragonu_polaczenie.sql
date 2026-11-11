-- ═══════════════════════════════════════════════════════════════
-- 00175: faktura do paragonu (FP) ze skrzynki KSeF łączy się z paragonem
-- z NIP wgranym wcześniej (plan kompletnej aplikacji, krok 1.3, część 2;
-- RP-FP-01, RP-KSEF-01)
--
-- KIEDY WGRAĆ: PRZED wdrożeniem. Nowa tabela, indeks, wyzwalacz i dwie
-- funkcje; bez DROP tabel i kolumn, bez zmiany istniejących danych. Stary
-- kod tabeli nie czyta, a wyzwalacz działa tylko na paragonach połączonych
-- z fakturą, których bez nowego kodu nie ma.
--
-- Jeden zakup, dwa dokumenty: paragon z NIP ze zdjęcia (koszt spoza KSeF)
-- i faktura do paragonu z KSeF (koszt ze skrzynki). Wzór połączenia jak
-- w 00121 (jeden koszt na fakturę): klucze obce w obrębie tej samej firmy
-- i indeksy UNIQUE, tu na parze kosztów.
--   linked     paragon wypada z KPiR i z odliczenia (`is_deductible = false`,
--              wartość sprzed połączenia w `receipt_was_deductible`); koszt
--              i odliczenie idą z faktury. Najwyżej jedno na fakturę i na
--              paragon.
--   candidate  ostrzeżenie o możliwym podwójnym koszcie na obu dokumentach,
--              do decyzji klienta (kilku kandydatów albo niepewne dopasowanie).
--   dismissed  ślad decyzji „to osobne koszty” albo rozłączenia: ponowienie
--              runnera nie odtwarza ani ostrzeżenia, ani połączenia.
--
-- Zapis tylko przez dwie funkcje dla service_role (wzór 00127): runner
-- skrzynki (`match_receipt_to_ksef_invoice`) i decyzja klienta z akcji
-- serwerowej po MFA (`decide_receipt_invoice_match`, członkostwo sprawdzane
-- w bazie, audyt w tej samej transakcji). Klient tylko czyta swoją firmę.
-- ═══════════════════════════════════════════════════════════════

BEGIN;

-- Cel kluczy obcych „ten sam tenant” (jak indeks 00073 na invoices dla 00121).
CREATE UNIQUE INDEX IF NOT EXISTS uq_expenses_tenant_id_id
  ON public.expenses (tenant_id, id);

CREATE TABLE IF NOT EXISTS public.expense_receipt_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  -- Koszt z faktury do paragonu (skrzynka KSeF).
  invoice_expense_id UUID NOT NULL,
  -- Koszt z paragonu z NIP (spoza KSeF).
  receipt_expense_id UUID NOT NULL,
  status TEXT NOT NULL,
  receipt_was_deductible BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT expense_receipt_matches_status_check
    CHECK (status IN ('linked', 'candidate', 'dismissed')),
  CONSTRAINT expense_receipt_matches_two_documents_check
    CHECK (invoice_expense_id <> receipt_expense_id),
  CONSTRAINT expense_receipt_matches_linked_restore_check
    CHECK (status <> 'linked' OR receipt_was_deductible IS NOT NULL),
  CONSTRAINT expense_receipt_matches_pair_unique
    UNIQUE (tenant_id, invoice_expense_id, receipt_expense_id),
  CONSTRAINT expense_receipt_matches_invoice_same_tenant_fk
    FOREIGN KEY (tenant_id, invoice_expense_id)
    REFERENCES public.expenses (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT expense_receipt_matches_receipt_same_tenant_fk
    FOREIGN KEY (tenant_id, receipt_expense_id)
    REFERENCES public.expenses (tenant_id, id) ON DELETE CASCADE
);

-- Jeden paragon na fakturę i jedna faktura na paragon.
CREATE UNIQUE INDEX IF NOT EXISTS uq_expense_receipt_matches_linked_invoice
  ON public.expense_receipt_matches (tenant_id, invoice_expense_id)
  WHERE status = 'linked';
CREATE UNIQUE INDEX IF NOT EXISTS uq_expense_receipt_matches_linked_receipt
  ON public.expense_receipt_matches (tenant_id, receipt_expense_id)
  WHERE status = 'linked';
CREATE INDEX IF NOT EXISTS idx_expense_receipt_matches_receipt
  ON public.expense_receipt_matches (tenant_id, receipt_expense_id);

ALTER TABLE public.expense_receipt_matches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "expense_receipt_matches_select_own_tenant" ON public.expense_receipt_matches;
CREATE POLICY "expense_receipt_matches_select_own_tenant" ON public.expense_receipt_matches
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_current_tenant_id());

REVOKE ALL ON public.expense_receipt_matches FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.expense_receipt_matches TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.expense_receipt_matches TO service_role;

COMMENT ON TABLE public.expense_receipt_matches IS
  'Receipt with NIP vs KSeF receipt invoice (FP) for one purchase: linked removes the receipt from KPiR and VAT; candidate is a double-cost warning awaiting the client; dismissed records the decision.';

-- Połączony paragon nie wraca do KPiR edycją klienta (podwójny koszt).
-- Wyjście: rozłączenie na stronie faktury (`decide_receipt_invoice_match`).
CREATE OR REPLACE FUNCTION public.guard_linked_receipt_expense()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF NEW.is_deductible IS TRUE
     AND OLD.is_deductible IS DISTINCT FROM TRUE
     AND EXISTS (
       SELECT 1 FROM public.expense_receipt_matches AS m
        WHERE m.tenant_id = OLD.tenant_id
          AND m.receipt_expense_id = OLD.id
          AND m.status = 'linked'
     ) THEN
    RAISE EXCEPTION 'Paragon jest połączony z fakturą do paragonu z KSeF, więc koszt liczy się z faktury. Żeby wliczyć paragon, najpierw rozłącz dokumenty na stronie faktury.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_linked_receipt_expense() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS b_guard_linked_receipt_expense ON public.expenses;
CREATE TRIGGER b_guard_linked_receipt_expense
  BEFORE UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.guard_linked_receipt_expense();

-- Runner skrzynki (service_role). Kandydatów wybiera kod (NIP, kwota, okno
-- dat, rodzaj paragonu); baza sprawdza firmę, pochodzenie obu kosztów
-- i jednorazowość. Zwraca: linked, candidates, already_recorded,
-- no_candidates, not_applicable. Ponowienie od zera: zapis dla faktury już
-- jest (także odrzucony przez klienta), więc drugie wykonanie nic nie zmienia.
CREATE OR REPLACE FUNCTION public.match_receipt_to_ksef_invoice(
  p_tenant_id uuid,
  p_invoice_expense_id uuid,
  p_receipt_expense_ids uuid[],
  p_auto_link boolean
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_ids uuid[];
  v_receipt public.expenses%ROWTYPE;
BEGIN
  IF current_user <> 'service_role'
     OR p_tenant_id IS NULL OR p_invoice_expense_id IS NULL
     OR p_receipt_expense_ids IS NULL OR p_auto_link IS NULL
     OR cardinality(p_receipt_expense_ids) > 50 THEN
    RAISE EXCEPTION 'Invalid receipt match request'
      USING ERRCODE = '42501';
  END IF;

  -- Blokada wiersza faktury szereguje równoległe przebiegi i decyzję klienta.
  PERFORM 1 FROM public.expenses AS e
   WHERE e.id = p_invoice_expense_id
     AND e.tenant_id = p_tenant_id
     AND e.source = 'ksef_inbox'
     AND e.ksef_invoice_id IS NOT NULL
   FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_applicable'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.expense_receipt_matches AS m
     WHERE m.tenant_id = p_tenant_id
       AND m.invoice_expense_id = p_invoice_expense_id
  ) THEN
    RETURN 'already_recorded';
  END IF;

  -- Paragony: koszty spoza KSeF tej firmy, niepołączone z inną fakturą.
  PERFORM 1 FROM public.expenses AS e
   WHERE e.id = ANY (p_receipt_expense_ids) AND e.tenant_id = p_tenant_id
   ORDER BY e.id
   FOR UPDATE;
  SELECT array_agg(e.id ORDER BY e.id) INTO v_ids
    FROM public.expenses AS e
   WHERE e.id = ANY (p_receipt_expense_ids)
     AND e.tenant_id = p_tenant_id
     AND e.source IS DISTINCT FROM 'ksef_inbox'
     AND e.ksef_invoice_id IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.expense_receipt_matches AS m
        WHERE m.tenant_id = p_tenant_id
          AND m.receipt_expense_id = e.id
          AND m.status = 'linked'
     );
  IF coalesce(cardinality(v_ids), 0) = 0 THEN RETURN 'no_candidates'; END IF;

  -- Samo łączy się tylko jeden pewny kandydat, który nie czeka już na decyzję
  -- przy innej fakturze.
  IF p_auto_link
     AND cardinality(p_receipt_expense_ids) = 1
     AND cardinality(v_ids) = 1
     AND NOT EXISTS (
       SELECT 1 FROM public.expense_receipt_matches AS m
        WHERE m.tenant_id = p_tenant_id
          AND m.receipt_expense_id = v_ids[1]
          AND m.status = 'candidate'
     ) THEN
    SELECT e.* INTO v_receipt FROM public.expenses AS e
     WHERE e.id = v_ids[1] AND e.tenant_id = p_tenant_id;

    INSERT INTO public.expense_receipt_matches (
      tenant_id, invoice_expense_id, receipt_expense_id, status, receipt_was_deductible
    ) VALUES (
      p_tenant_id, p_invoice_expense_id, v_receipt.id, 'linked', v_receipt.is_deductible
    );
    UPDATE public.expenses AS e
       SET is_deductible = false
     WHERE e.id = v_receipt.id AND e.tenant_id = p_tenant_id;

    INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
    VALUES (
      p_tenant_id, NULL, 'expense.receipt_invoice_linked', 'expense', p_invoice_expense_id,
      jsonb_build_object('receiptExpenseId', v_receipt.id, 'by', 'auto',
                         'receiptWasDeductible', v_receipt.is_deductible)
    );
    RETURN 'linked';
  END IF;

  INSERT INTO public.expense_receipt_matches (tenant_id, invoice_expense_id, receipt_expense_id, status)
  SELECT p_tenant_id, p_invoice_expense_id, x.id, 'candidate'
    FROM unnest(v_ids) AS x(id)
  ON CONFLICT (tenant_id, invoice_expense_id, receipt_expense_id) DO NOTHING;

  -- Faktura czeka na decyzję klienta: w Skrzynce status „Nowa”.
  UPDATE public.expenses AS e
     SET is_reviewed = false
   WHERE e.id = p_invoice_expense_id AND e.tenant_id = p_tenant_id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    p_tenant_id, NULL, 'expense.receipt_invoice_candidates', 'expense', p_invoice_expense_id,
    jsonb_build_object('receiptExpenseIds', to_jsonb(v_ids), 'autoLinkRequested', p_auto_link)
  );
  RETURN 'candidates';
END;
$$;

REVOKE ALL ON FUNCTION public.match_receipt_to_ksef_invoice(uuid, uuid, uuid[], boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.match_receipt_to_ksef_invoice(uuid, uuid, uuid[], boolean)
  TO service_role;

-- Decyzja klienta z akcji serwerowej (service_role po MFA i wyborze firmy).
-- p_receipt_expense_id: wybrany kandydat; NULL: „to osobne koszty”, czyli
-- odrzucenie kandydatów albo rozłączenie (paragon wraca do KPiR z wartością
-- sprzed połączenia). Zwraca: linked, separated, stale.
CREATE OR REPLACE FUNCTION public.decide_receipt_invoice_match(
  p_tenant_id uuid,
  p_invoice_expense_id uuid,
  p_actor_user_id uuid,
  p_receipt_expense_id uuid DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_linked public.expense_receipt_matches%ROWTYPE;
  v_receipt public.expenses%ROWTYPE;
  v_dismissed integer;
BEGIN
  IF current_user <> 'service_role'
     OR p_tenant_id IS NULL OR p_invoice_expense_id IS NULL
     OR p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'Invalid receipt match decision'
      USING ERRCODE = '42501';
  END IF;

  -- FOR SHARE szereguje decyzję z równoległym odebraniem członkostwa.
  PERFORM 1 FROM public.memberships AS m
   WHERE m.organization_id = p_tenant_id
     AND m.user_id = p_actor_user_id
     AND m.status = 'active'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active organization membership'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM public.expenses AS e
   WHERE e.id = p_invoice_expense_id
     AND e.tenant_id = p_tenant_id
     AND e.source = 'ksef_inbox'
     AND e.ksef_invoice_id IS NOT NULL
   FOR UPDATE;
  IF NOT FOUND THEN RETURN 'stale'; END IF;

  PERFORM 1 FROM public.expense_receipt_matches AS m
   WHERE m.tenant_id = p_tenant_id AND m.invoice_expense_id = p_invoice_expense_id
   FOR UPDATE;

  IF p_receipt_expense_id IS NOT NULL THEN
    IF NOT EXISTS (
         SELECT 1 FROM public.expense_receipt_matches AS m
          WHERE m.tenant_id = p_tenant_id AND m.invoice_expense_id = p_invoice_expense_id
            AND m.receipt_expense_id = p_receipt_expense_id AND m.status = 'candidate')
       OR EXISTS (
         SELECT 1 FROM public.expense_receipt_matches AS m
          WHERE m.tenant_id = p_tenant_id AND m.status = 'linked'
            AND (m.invoice_expense_id = p_invoice_expense_id
                 OR m.receipt_expense_id = p_receipt_expense_id)) THEN
      RETURN 'stale';
    END IF;

    SELECT e.* INTO v_receipt FROM public.expenses AS e
     WHERE e.id = p_receipt_expense_id AND e.tenant_id = p_tenant_id
       AND e.source IS DISTINCT FROM 'ksef_inbox' AND e.ksef_invoice_id IS NULL
     FOR UPDATE;
    IF NOT FOUND THEN RETURN 'stale'; END IF;

    UPDATE public.expense_receipt_matches AS m
       SET status = 'linked', receipt_was_deductible = v_receipt.is_deductible, updated_at = now()
     WHERE m.tenant_id = p_tenant_id AND m.invoice_expense_id = p_invoice_expense_id
       AND m.receipt_expense_id = p_receipt_expense_id;
    UPDATE public.expense_receipt_matches AS m
       SET status = 'dismissed', updated_at = now()
     WHERE m.tenant_id = p_tenant_id AND m.invoice_expense_id = p_invoice_expense_id
       AND m.receipt_expense_id <> p_receipt_expense_id AND m.status = 'candidate';
    UPDATE public.expenses AS e
       SET is_deductible = false
     WHERE e.id = v_receipt.id AND e.tenant_id = p_tenant_id;

    INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
    VALUES (
      p_tenant_id, p_actor_user_id, 'expense.receipt_invoice_linked', 'expense', p_invoice_expense_id,
      jsonb_build_object('receiptExpenseId', v_receipt.id, 'by', 'client',
                         'receiptWasDeductible', v_receipt.is_deductible)
    );
    RETURN 'linked';
  END IF;

  SELECT m.* INTO v_linked FROM public.expense_receipt_matches AS m
   WHERE m.tenant_id = p_tenant_id AND m.invoice_expense_id = p_invoice_expense_id
     AND m.status = 'linked';
  IF FOUND THEN
    UPDATE public.expenses AS e
       SET is_deductible = v_linked.receipt_was_deductible
     WHERE e.id = v_linked.receipt_expense_id AND e.tenant_id = p_tenant_id;
  END IF;

  UPDATE public.expense_receipt_matches AS m
     SET status = 'dismissed', updated_at = now()
   WHERE m.tenant_id = p_tenant_id AND m.invoice_expense_id = p_invoice_expense_id
     AND m.status IN ('linked', 'candidate');
  GET DIAGNOSTICS v_dismissed = ROW_COUNT;
  IF v_dismissed = 0 THEN RETURN 'stale'; END IF;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    p_tenant_id, p_actor_user_id, 'expense.receipt_invoice_separated', 'expense', p_invoice_expense_id,
    jsonb_build_object('unlinkedReceiptExpenseId', v_linked.receipt_expense_id, 'dismissed', v_dismissed)
  );
  RETURN 'separated';
END;
$$;

REVOKE ALL ON FUNCTION public.decide_receipt_invoice_match(uuid, uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.decide_receipt_invoice_match(uuid, uuid, uuid, uuid)
  TO service_role;

COMMIT;

-- PostgREST na self-hosted trzyma podpisy RPC w pamięci podręcznej.
NOTIFY pgrst, 'reload schema';
