-- ═══════════════════════════════════════════════════════════════
-- 00176: wpłaty częściowe i historia wpłat przy fakturze sprzedaży
-- (plan kompletnej aplikacji, krok 3.1).
--
-- Tabela wpłat już jest: `payments` (00014) z `tenant_id`, RLS, kluczem złożonym
-- do faktury (00073) i wyzwalaczem, który liczy `invoices.paid_amount` jako sumę
-- wpłat (`recalculate_invoice_paid_amount`, 00073), a stan płatności ustawia
-- `update_invoice_payment_status` (00145). Piszą do niej „Zapłacone” jednym
-- dotknięciem (`mark_invoice_paid`, 00158, match_method = 'manual') i karta FLO
-- (`flo_confirmation`, wyłączona). Druga tabela rozbiłaby `paid_amount` na dwa
-- źródła, więc ta migracja rozszerza `payments`, a wszystkie drogi zapisują do
-- jednej księgi wpłat:
--   - kolumny `idempotency_key` (klucz od klienta: ta sama wpłata wysłana dwa
--     razy zapisuje się raz), `created_by`, `voided_at`, `voided_by` (cofnięcie
--     zostawia wiersz oznaczony jako cofnięty, a nie usuwa go);
--   - wyzwalacz sumy liczy tylko wpłaty niecofnięte;
--   - cofnięty wiersz jest tylko do odczytu (wyzwalacz `a_guard_payment_voided`);
--   - RPC dla sesji: `record_invoice_payment` (zapis), `void_invoice_payment`
--     (cofnięcie) i `invoice_payments` (historia do odczytu). Tabela zostaje
--     zablokowana dla sesji (00074): sesja nie czyta ani nie pisze jej wprost.
--
-- Zasady jak w `mark_invoice_paid` (00158): firma i rola z sesji (owner, admin,
-- member; księgowa ma wgląd), blokada wiersza faktury w jednej transakcji z
-- zapisem, odmowy dla zakupu, szkicu, korekty in minus i faktury skorygowanej do
-- zera, ROZ liczona od `payment_data.amountDue`, dzień w Europe/Warsaw, data nie
-- z przyszłości i nie sprzed 2000 r. Do tego: kwota dodatnia, najwyżej dwa miejsca
-- po przecinku i nie ponad resztę do zapłaty (nadpłat nie zapisujemy), tylko PLN
-- (faktury walutowe dojdą w kroku 2.1), notatka do 500 znaków. Audyt
-- (`invoice.payment_recorded`, `invoice.payment_voided`) dopisują same RPC w tej
-- samej transakcji co wpłata, jak w 00158.
--
-- „Zapłacone” (00158) zostaje bez zmian: jego wpłata pojawia się w historii,
-- a cofa się dotychczasową drogą `undo_invoice_paid` (usunięcie z wpisem
-- `invoice.paid_undone` i zwolnieniem przypomnień). `void_invoice_payment`
-- przekazuje taką wpłatę do `undo_invoice_paid`. Wpłaty sprzed „Zapłacone” nie
-- da się cofnąć, dopóki stoi „Zapłacone” policzone jako reszta po niej
-- (odmowa `manual_first` z dniem i kwotą oznaczenia: najpierw cofnięcie oznaczenia).
--
-- Istniejące dane: `paid_amount` zawsze był sumą wierszy `payments` (wyzwalacz
-- od 00014, zapis z sesji zablokowany przez `guard_invoice_payment_evidence`
-- z 00073), więc każda faktura z wpłatą MA już wiersze i historia je pokazuje.
-- Wpłaty historycznej nie dopisujemy. Faktury z datą zapłaty z FA(3) (import)
-- nie mają wpłat i dalej mówią „data z faktury”. Przed wgraniem na produkcję
-- sprawdź, że suma się zgadza (oczekiwane 0):
--   SELECT count(*) FROM public.invoices AS i
--    WHERE i.paid_amount <> (SELECT COALESCE(SUM(p.amount), 0) FROM public.payments AS p
--                             WHERE p.tenant_id = i.tenant_id AND p.invoice_id = i.id
--                               AND (p.is_auto_matched = false OR p.is_confirmed = true));
-- i że nikt nie używa jeszcze nowych nazw (oczekiwane 0):
--   SELECT count(*) FROM public.payments WHERE match_method = 'manual_entry';
--
-- Kolejność: PRZED wdrożeniem (addytywna: nowe kolumny NULL bez domyślnych
-- wartości, nowy CHECK spełniony przez istniejące wiersze, nowe indeksy, nowe
-- funkcje, CREATE OR REPLACE funkcji sumy z tym samym zachowaniem dla wierszy bez
-- cofnięcia i CREATE OR REPLACE TRIGGER z dodatkową kolumną). Stara wersja
-- aplikacji nowych funkcji nie woła, a jej zapisy (00158, FLO) mają `voided_at`
-- NULL, więc liczą się jak dotąd. Bez DROP tabel i kolumn, bez TRUNCATE, bez
-- zmiany danych przy wgraniu; UPDATE i INSERT do audit_logs tylko w ciałach
-- funkcji, na żądanie klienta.
-- Rejestr numerów: docs/koordynacja/CLAUDE-DO-CODEXA.md.
-- ═══════════════════════════════════════════════════════════════

-- 1. Kolumny wpłat: klucz idempotencji, autor i cofnięcie.
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS idempotency_key uuid,
  ADD COLUMN IF NOT EXISTS created_by uuid,
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by uuid;

COMMENT ON COLUMN public.payments.idempotency_key IS
  'Klucz od klienta (00176): ta sama wpłata wysłana dwa razy zapisuje się raz. Unikalny w obrębie firmy, zostaje przy wierszu cofniętym.';
COMMENT ON COLUMN public.payments.created_by IS
  'Kto zapisał wpłatę (auth.uid() z sesji, 00176). NULL przy wpłatach sprzed 00176 i z zadań serwera.';
COMMENT ON COLUMN public.payments.voided_at IS
  'Cofnięcie wpłaty (00176): wiersz zostaje jako ślad, a wyzwalacz sumy go pomija. Po cofnięciu wiersz jest tylko do odczytu.';
COMMENT ON COLUMN public.payments.voided_by IS
  'Kto cofnął wpłatę (auth.uid() z sesji, 00176).';

-- DROP CONSTRAINT IF EXISTS tylko dla CHECK-u z tej migracji, żeby dało się ją powtórzyć.
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_voided_by_requires_voided_at;
ALTER TABLE public.payments ADD CONSTRAINT payments_voided_by_requires_voided_at
  CHECK (voided_by IS NULL OR voided_at IS NOT NULL);

-- 2. Jeden klucz = jedna wpłata w firmie (także po cofnięciu: ponowienie nie wskrzesza wpłaty).
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_tenant_idempotency_key
  ON public.payments (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 3. Suma wpłat bez cofniętych. Ciało z 00073, jedyna zmiana: `p.voided_at IS NULL`.
CREATE OR REPLACE FUNCTION public.recalculate_invoice_paid_amount()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_recalc_new boolean := false;
BEGIN
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    UPDATE public.invoices AS i
       SET paid_amount = (
         SELECT COALESCE(SUM(p.amount), 0)
           FROM public.payments AS p
          WHERE p.tenant_id = i.tenant_id
            AND p.invoice_id = i.id
            AND (p.is_auto_matched = false OR p.is_confirmed = true)
            AND p.voided_at IS NULL
       )
     WHERE i.tenant_id = OLD.tenant_id AND i.id = OLD.invoice_id;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_recalc_new := true;
  ELSIF TG_OP = 'UPDATE' THEN
    v_recalc_new := NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id;
  END IF;

  IF v_recalc_new THEN
    UPDATE public.invoices AS i
       SET paid_amount = (
         SELECT COALESCE(SUM(p.amount), 0)
           FROM public.payments AS p
          WHERE p.tenant_id = i.tenant_id
            AND p.invoice_id = i.id
            AND (p.is_auto_matched = false OR p.is_confirmed = true)
            AND p.voided_at IS NULL
       )
     WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.invoice_id;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- Ta sama nazwa, czas i poziom co w 00073, z `voided_at` na liście kolumn (bez DROP, PG 14+).
CREATE OR REPLACE TRIGGER trigger_recalculate_paid_amount
  AFTER INSERT OR DELETE OR UPDATE OF amount, is_confirmed, is_auto_matched,
    invoice_id, tenant_id, voided_at ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.recalculate_invoice_paid_amount();

-- 4. Cofnięta wpłata to ślad: nikt jej już nie zmienia (także klucz serwisowy).
--    Usunięcie zostaje możliwe, bo kaskada z faktury (retencja) musi działać.
--    Klucz idempotencji i autor nie zmieniają się nigdy.
CREATE OR REPLACE FUNCTION public.guard_payment_voided()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'Voided payment is read-only' USING ERRCODE = '42501';
  END IF;
  IF (OLD.idempotency_key IS NOT NULL AND NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key)
     OR (OLD.created_by IS NOT NULL AND NEW.created_by IS DISTINCT FROM OLD.created_by) THEN
    RAISE EXCEPTION 'Payment key and author are immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER a_guard_payment_voided
  BEFORE UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.guard_payment_voided();

-- 5. Zapis wpłaty. Wynik zawsze jsonb ze `status`: `recorded`, `already_recorded`
--    (ten sam klucz z tymi samymi danymi) albo `refused` z `code`.
CREATE OR REPLACE FUNCTION public.record_invoice_payment(
  p_invoice_id uuid,
  p_amount numeric,
  p_idempotency_key uuid,
  p_paid_on date DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_currency text DEFAULT 'PLN'
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
  v_note text;
  v_invoice public.invoices%ROWTYPE;
  v_existing public.payments%ROWTYPE;
  v_due numeric;
  v_rest numeric;
  v_corrections numeric;
  v_payment_id uuid;
  v_paid numeric;
  v_status text;
  v_paid_day date;
  v_reminders integer := 0;
BEGIN
  IF auth.uid() IS NULL OR p_invoice_id IS NULL THEN
    RAISE EXCEPTION 'Invoice payment change requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.has_org_role(v_tenant_id, 'owner')
          OR public.has_org_role(v_tenant_id, 'admin')
          OR public.has_org_role(v_tenant_id, 'member')) THEN
    RAISE EXCEPTION 'Insufficient role to change invoice payment' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_request');
  END IF;

  -- Blokada wiersza faktury: dwa zapisy naraz (dwie karty, dwa telefony, ponowienie
  -- w słabym zasięgu) idą po kolei, drugi widzi już pierwszą wpłatę i jej klucz.
  SELECT * INTO v_invoice
    FROM public.invoices
   WHERE id = p_invoice_id AND tenant_id = v_tenant_id
   FOR UPDATE;
  -- Faktura obcej firmy wygląda jak brak faktury: bez informacji, że istnieje.
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_found');
  END IF;

  -- Ten sam klucz: ta sama wpłata. Sprawdzamy go przed stanem faktury, bo po
  -- pierwszym zapisie faktura mogła już zostać zapłacona (to sukces, nie odmowa).
  SELECT * INTO v_existing
    FROM public.payments
   WHERE tenant_id = v_tenant_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.invoice_id = p_invoice_id
       AND v_existing.amount = p_amount
       AND v_existing.payment_date = COALESCE(p_paid_on, v_existing.payment_date) THEN
      RETURN jsonb_build_object(
        'status', 'already_recorded',
        'payment_id', v_existing.id,
        'amount', v_existing.amount,
        'paid_on', v_existing.payment_date,
        'voided', v_existing.voided_at IS NOT NULL,
        'remaining', GREATEST(
          CASE
            WHEN v_invoice.invoice_kind = 'final' AND v_invoice.gross_total IS NOT NULL
                 AND (v_invoice.payment_data ->> 'amountDue') ~ '^[0-9]+(\.[0-9]+)?$'
            THEN LEAST((v_invoice.payment_data ->> 'amountDue')::numeric, v_invoice.gross_total)
            ELSE v_invoice.gross_total
          END - v_invoice.paid_amount, 0),
        'payment_status', v_invoice.payment_status,
        'internal_number', v_invoice.internal_number
      );
    END IF;
    RETURN jsonb_build_object('status', 'refused', 'code', 'key_reused', 'internal_number', v_invoice.internal_number);
  END IF;

  IF v_invoice.direction IS DISTINCT FROM 'outgoing' THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_sales', 'internal_number', v_invoice.internal_number);
  END IF;
  IF v_invoice.ksef_status IS DISTINCT FROM 'accepted' THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_accepted', 'internal_number', v_invoice.internal_number);
  END IF;
  -- Faktury walutowe przyjdą w kroku 2.1: bez kursu nie zapisujemy złotówek za euro.
  IF v_invoice.currency IS NOT NULL AND upper(btrim(v_invoice.currency)) <> 'PLN' THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invoice_currency',
      'currency', v_invoice.currency, 'internal_number', v_invoice.internal_number);
  END IF;
  IF p_currency IS NULL OR upper(btrim(p_currency)) <> 'PLN' THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'payment_currency', 'internal_number', v_invoice.internal_number);
  END IF;
  -- Kolumna NUMERIC(15,2) zaokrągliłaby 10,005 po cichu: kwota z groszami albo odmowa.
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_amount', 'internal_number', v_invoice.internal_number);
  END IF;

  v_paid_on := COALESCE(p_paid_on, v_today);
  IF v_paid_on > v_today THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'future_date', 'internal_number', v_invoice.internal_number);
  END IF;
  -- Literówka w roku w polu daty (0202 zamiast 2026) nie jest datą wpłaty.
  IF v_paid_on < DATE '2000-01-01' THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_date', 'internal_number', v_invoice.internal_number);
  END IF;
  v_note := NULLIF(btrim(p_note), '');
  IF v_note IS NOT NULL AND char_length(v_note) > 500 THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'note_too_long', 'internal_number', v_invoice.internal_number);
  END IF;

  -- Do zapłaty liczone jak w update_invoice_payment_status (00145), mark_invoice_paid
  -- (00158) i `lib/invoices/amount-due.ts`: ROZ płaci resztę po zaliczkach.
  IF v_invoice.invoice_kind = 'final'
     AND v_invoice.gross_total IS NOT NULL
     AND (v_invoice.payment_data ->> 'amountDue') ~ '^[0-9]+(\.[0-9]+)?$'
  THEN
    v_due := LEAST((v_invoice.payment_data ->> 'amountDue')::numeric, v_invoice.gross_total);
  ELSE
    v_due := v_invoice.gross_total;
  END IF;

  -- Te same warunki „już zapłacona” co w mark_invoice_paid (00158).
  IF v_invoice.payment_status = 'paid'
     OR (v_invoice.fa3_data -> 'parsed' ->> 'paidDate') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     OR (v_invoice.invoice_kind = 'final' AND v_due = 0)
     OR (v_due > 0 AND v_invoice.paid_amount >= v_due)
  THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'already_paid', 'internal_number', v_invoice.internal_number);
  END IF;

  -- Korekta in minus albo dokument bez kwoty: nikt tu nic nie płaci.
  IF v_due IS NULL OR v_due <= 0 THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'nothing_to_pay', 'internal_number', v_invoice.internal_number);
  END IF;
  v_rest := v_due - v_invoice.paid_amount;

  -- Faktura skorygowana do zera (jak w 00158): nabywca nic nie jest winien.
  SELECT COALESCE(SUM(c.gross_total), 0) INTO v_corrections
    FROM public.invoices AS c
   WHERE c.tenant_id = v_tenant_id
     AND c.parent_invoice_id = p_invoice_id
     AND c.ksef_status = 'accepted';
  IF v_rest + v_corrections <= 0 THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'corrected_to_zero', 'internal_number', v_invoice.internal_number);
  END IF;

  -- Nadpłata to osobna sprawa (zwrot, zaliczenie na inną fakturę): nie zapisujemy jej.
  IF p_amount > v_rest THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'over_remaining',
      'remaining', v_rest, 'internal_number', v_invoice.internal_number);
  END IF;

  BEGIN
    INSERT INTO public.payments (
      tenant_id, invoice_id, amount, payment_date, payment_method,
      is_confirmed, is_auto_matched, match_method, notes, idempotency_key, created_by
    ) VALUES (
      v_tenant_id, p_invoice_id, p_amount, v_paid_on, 'other',
      true, false, 'manual_entry', v_note, p_idempotency_key, auth.uid()
    )
    RETURNING id INTO v_payment_id;
  EXCEPTION WHEN unique_violation THEN
    -- Ten sam klucz zapisał się w tej chwili przy innej fakturze (blokada innego
    -- wiersza nie czekała na nas): to ponowne użycie klucza, nie druga wpłata.
    RETURN jsonb_build_object('status', 'refused', 'code', 'key_reused', 'internal_number', v_invoice.internal_number);
  END;

  -- Wyzwalacze przeliczyły już paid_amount i payment_status.
  SELECT paid_amount, payment_status INTO v_paid, v_status
    FROM public.invoices
   WHERE id = p_invoice_id AND tenant_id = v_tenant_id;

  IF v_status = 'paid' THEN
    -- Faktura zapłacona w całości w dniu najpóźniejszej wpłaty, a nie w dniu zapisu.
    -- Południe w Warszawie, jak w 00158 (`inflowDay` liczy dzień w Warszawie).
    SELECT max(p.payment_date) INTO v_paid_day
      FROM public.payments AS p
     WHERE p.tenant_id = v_tenant_id
       AND p.invoice_id = p_invoice_id
       AND (p.is_auto_matched = false OR p.is_confirmed = true)
       AND p.voided_at IS NULL;
    IF v_paid_day IS NOT NULL AND v_paid_day <> v_today THEN
      UPDATE public.invoices
         SET paid_at = (v_paid_day + TIME '12:00') AT TIME ZONE 'Europe/Warsaw'
       WHERE id = p_invoice_id AND tenant_id = v_tenant_id;
    END IF;

    -- Jak mark_invoice_paid: zapłacona faktura nie dostaje ponaglenia. Ten sam znacznik,
    -- więc cofnięcie (tu i w undo_invoice_paid) zwalnia etap tak samo.
    UPDATE public.payment_reminders
       SET status = 'cancelled',
           failure_reason = 'Faktura oznaczona jako zapłacona'
     WHERE tenant_id = v_tenant_id
       AND invoice_id = p_invoice_id
       AND status = 'pending';
    GET DIAGNOSTICS v_reminders = ROW_COUNT;
  END IF;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_tenant_id, auth.uid(), 'invoice.payment_recorded', 'invoice', p_invoice_id,
    jsonb_build_object(
      'paymentId', v_payment_id,
      'amount', p_amount,
      'paidOn', v_paid_on,
      'hasNote', v_note IS NOT NULL,
      'remaining', GREATEST(v_due - v_paid, 0),
      'paymentStatus', v_status,
      'remindersCancelled', v_reminders
    )
  );

  RETURN jsonb_build_object(
    'status', 'recorded',
    'payment_id', v_payment_id,
    'amount', p_amount,
    'paid_on', v_paid_on,
    'remaining', GREATEST(v_due - v_paid, 0),
    'payment_status', v_status,
    'reminders_cancelled', v_reminders,
    'internal_number', v_invoice.internal_number
  );
END;
$$;

COMMENT ON FUNCTION public.record_invoice_payment(uuid, numeric, uuid, date, text, text) IS
  'Zapisuje wpłatę (także częściową) do faktury sprzedaży przyjętej w KSeF: kwota dodatnia, '
  'nie ponad resztę, tylko PLN, dzień nie z przyszłości; klucz idempotencji od klienta; '
  'blokada wiersza faktury, wpis audytu (invoice.payment_recorded) w jednej transakcji (00176).';

-- 6. Cofnięcie wpłaty. Wynik: `voided` (mode `voided` albo `undo_paid`),
--    `already_voided` albo `refused` z `code`.
CREATE OR REPLACE FUNCTION public.void_invoice_payment(p_payment_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  v_invoice_id uuid;
  v_invoice public.invoices%ROWTYPE;
  v_payment public.payments%ROWTYPE;
  v_manual public.payments%ROWTYPE;
  v_undo jsonb;
  v_due numeric;
  v_paid numeric;
  v_status text;
  v_reminders integer := 0;
BEGIN
  IF auth.uid() IS NULL OR p_payment_id IS NULL THEN
    RAISE EXCEPTION 'Invoice payment change requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant_id := public.get_current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.has_org_role(v_tenant_id, 'owner')
          OR public.has_org_role(v_tenant_id, 'admin')
          OR public.has_org_role(v_tenant_id, 'member')) THEN
    RAISE EXCEPTION 'Insufficient role to change invoice payment' USING ERRCODE = '42501';
  END IF;

  -- Najpierw faktura, potem wpłata: ta sama kolejność blokad co przy zapisie.
  SELECT p.invoice_id INTO v_invoice_id
    FROM public.payments AS p
   WHERE p.id = p_payment_id AND p.tenant_id = v_tenant_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_found');
  END IF;

  SELECT * INTO v_invoice
    FROM public.invoices
   WHERE id = v_invoice_id AND tenant_id = v_tenant_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_found');
  END IF;

  SELECT * INTO v_payment
    FROM public.payments
   WHERE id = p_payment_id AND tenant_id = v_tenant_id AND invoice_id = v_invoice_id
   FOR UPDATE;
  -- Wpłatę z „Zapłacone” ktoś właśnie cofnął drugą kartą (undo_invoice_paid ją usuwa).
  IF NOT FOUND OR v_payment.voided_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'already_voided', 'payment_id', p_payment_id,
      'invoice_id', v_invoice_id, 'internal_number', v_invoice.internal_number);
  END IF;
  -- Niepotwierdzone dopasowanie z banku nie jest wpłatą (nie liczy się do sumy).
  IF v_payment.is_auto_matched AND NOT v_payment.is_confirmed THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_voidable', 'internal_number', v_invoice.internal_number);
  END IF;

  -- „Zapłacone” jednym dotknięciem (00158): cofnięcie jego drogą.
  IF v_payment.match_method = 'manual' THEN
    v_undo := public.undo_invoice_paid(v_invoice_id);
    IF v_undo ->> 'status' = 'undone' THEN
      RETURN jsonb_build_object(
        'status', 'voided',
        'mode', 'undo_paid',
        'payment_id', p_payment_id,
        'invoice_id', v_invoice_id,
        'amount', v_undo -> 'amount',
        'paid_on', v_undo -> 'paid_on',
        'reminders_restored', v_undo -> 'reminders_restored',
        'internal_number', v_invoice.internal_number
      );
    END IF;
    RETURN jsonb_build_object('status', 'already_voided', 'payment_id', p_payment_id,
      'invoice_id', v_invoice_id, 'internal_number', v_invoice.internal_number);
  END IF;

  -- Wpłaty z wyciągu i inne zapisy serwera cofa ich własna droga (import, operator).
  IF v_payment.match_method IS DISTINCT FROM 'manual_entry'
     AND v_payment.match_method IS DISTINCT FROM 'flo_confirmation' THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_voidable', 'internal_number', v_invoice.internal_number);
  END IF;

  -- „Zapłacone” zapisało resztę policzoną po tej wpłacie. Cofnięcie samej wpłaty
  -- zostawiłoby tamtą resztę złą, więc najpierw cofa się oznaczenie.
  SELECT * INTO v_manual
    FROM public.payments
   WHERE tenant_id = v_tenant_id
     AND invoice_id = v_invoice_id
     AND match_method = 'manual'
     AND voided_at IS NULL
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'manual_first',
      'manual_paid_on', v_manual.payment_date, 'manual_amount', v_manual.amount,
      'internal_number', v_invoice.internal_number);
  END IF;

  UPDATE public.payments
     SET voided_at = now(),
         voided_by = auth.uid()
   WHERE id = p_payment_id AND tenant_id = v_tenant_id;

  -- Wyzwalacze przeliczyły już paid_amount, payment_status i paid_at.
  SELECT paid_amount, payment_status INTO v_paid, v_status
    FROM public.invoices
   WHERE id = v_invoice_id AND tenant_id = v_tenant_id;

  -- Faktura przestała być zapłacona: etapy przypomnień anulowane zapłatą wracają do
  -- harmonogramu z nową zgodą człowieka. Ten sam blok co w undo_invoice_paid (00158):
  -- wysyłka z potwierdzeniem dostawy (`reminderReceipt`) zostaje, stara zgoda traci zlecenie.
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
                 'reason', 'void_invoice_payment'
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
      'paymentId', p_payment_id,
      'amount', v_payment.amount,
      'paidOn', v_payment.payment_date,
      'source', v_payment.match_method,
      'remaining', GREATEST(COALESCE(v_due, 0) - v_paid, 0),
      'paymentStatus', v_status,
      'remindersRestored', v_reminders
    )
  );

  RETURN jsonb_build_object(
    'status', 'voided',
    'mode', 'voided',
    'payment_id', p_payment_id,
    'invoice_id', v_invoice_id,
    'amount', v_payment.amount,
    'paid_on', v_payment.payment_date,
    'remaining', GREATEST(COALESCE(v_due, 0) - v_paid, 0),
    'payment_status', v_status,
    'reminders_restored', v_reminders,
    'internal_number', v_invoice.internal_number
  );
END;
$$;

COMMENT ON FUNCTION public.void_invoice_payment(uuid) IS
  'Cofa wpłatę wpisaną ręcznie albo z karty FLO: wiersz zostaje oznaczony jako cofnięty, '
  'suma i stan przeliczone, etapy przypomnień anulowane zapłatą zwolnione, wpis audytu '
  '(invoice.payment_voided) w jednej transakcji. Wpłatę z „Zapłacone” cofa undo_invoice_paid (00176).';

-- 7. Historia wpłat faktury aktywnej firmy dla szczegółów faktury (`payments` nie ma
--    odczytu dla sesji, 00074). Bez danych rachunku płatnika i wiersza wyciągu.
--    Notatka tylko przy wpłatach wpisanych ręcznie (w pozostałych `notes` to opis
--    systemu). Niepotwierdzone dopasowania z banku nie są wpłatami.
CREATE OR REPLACE FUNCTION public.invoice_payments(p_invoice_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', p.id,
        'amount', p.amount,
        'paid_on', p.payment_date,
        'source', p.match_method,
        'note', CASE WHEN p.match_method = 'manual_entry' THEN p.notes END,
        'recorded_at', p.created_at,
        'voided_at', p.voided_at
      )
      ORDER BY p.payment_date, p.created_at, p.id
    ),
    '[]'::jsonb
  )
    FROM public.payments AS p
   WHERE p.tenant_id = public.get_current_tenant_id()
     AND p.invoice_id = p_invoice_id
     AND (p.is_auto_matched = false OR p.is_confirmed = true);
$$;

COMMENT ON FUNCTION public.invoice_payments(uuid) IS
  'Historia wpłat faktury aktywnej firmy (także cofnięte, z datą cofnięcia); lista pusta dla obcej firmy (00176).';

-- Supabase nadaje EXECUTE rolom anon i authenticated jawnie, samo FROM PUBLIC nic
-- nie odbiera (AUD-30). Tylko sesja zalogowanego: klucz serwisowy nie ma auth.uid().
REVOKE ALL ON FUNCTION public.record_invoice_payment(uuid, numeric, uuid, date, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_invoice_payment(uuid, numeric, uuid, date, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.void_invoice_payment(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.void_invoice_payment(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.invoice_payments(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.invoice_payments(uuid) TO authenticated;
-- Funkcje wyzwalaczy nie są do wołania przez API.
REVOKE ALL ON FUNCTION public.guard_payment_voided() FROM PUBLIC, anon, authenticated;
