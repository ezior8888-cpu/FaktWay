-- ═══════════════════════════════════════════════════════════════
-- 00158: „Zapłacone” jednym dotknięciem (FaktWay 1.0 §3 pkt 3).
--
-- Decyzję D-W z 23.10.2026 („klient nic nie oznacza, zakładamy zapłatę
-- w terminie”) odwołano 02.11.2026 na polecenie Bartosza. Klient oznacza
-- zapłatę sam, a wpływy liczymy wyłącznie z prawdziwych pieniędzy.
--
-- Tabela `payments` zostaje zablokowana dla sesji (00073, 00074). Jedyna droga
-- zapisu z sesji to dwa RPC niżej, trzeci tylko czyta:
--   - mark_invoice_paid(uuid, date)  oznacza fakturę sprzedaży przyjętą w KSeF,
--   - undo_invoice_paid(uuid)        cofa TYLKO wpłatę ręczną z mark_invoice_paid,
--   - invoice_manual_payment(uuid)   mówi szczegółom faktury, czy jest co cofać.
-- `paid_amount`, `paid_at` i `payment_status` dalej przeliczają wyzwalacze
-- (recalculate_invoice_paid_amount z 00073, update_invoice_payment_status
-- z 00145). Funkcje ustawiają ręcznie tylko dzień `paid_at` przy wybranej dacie.
--
-- Kto: właściciel, administrator, członek firmy (jak EDITOR_ROLES w
-- app/actions/contractors.ts). Księgowa ma wgląd: oznaczenie to zapis w danych
-- firmy, a nie w jej księgach. Rola i firma z sesji, nie z argumentów.
--
-- Kolejność: PRZED wdrożeniem (addytywna: nowy indeks częściowy i trzy nowe
-- funkcje). Stara wersja aplikacji ich nie woła. DELETE w ciele
-- undo_invoice_paid działa dopiero na żądanie klienta i tylko na wierszach
-- z tej funkcji, przy wgraniu żadne dane się nie zmieniają (bez DROP,
-- TRUNCATE i DML poza ciałami funkcji). Na produkcji nie ma wpłat
-- z match_method = 'manual', więc indeks powstaje bez kolizji.
-- Rejestr numerów: docs/koordynacja/CLAUDE-DO-CODEXA.md.
-- ═══════════════════════════════════════════════════════════════

-- Jedna wpłata ręczna na fakturę: po oznaczeniu reszta do zapłaty jest zerowa,
-- więc drugiej być nie może. Indeks pilnuje tego także bez blokady wiersza,
-- a cofnięcie zawsze wie, który wiersz usunąć.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_manual_per_invoice
  ON public.payments (tenant_id, invoice_id)
  WHERE match_method = 'manual';

CREATE OR REPLACE FUNCTION public.mark_invoice_paid(
  p_invoice_id uuid,
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
  v_invoice public.invoices%ROWTYPE;
  v_due numeric;
  v_rest numeric;
  v_corrections numeric;
  v_payment_id uuid;
  v_reminders integer;
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

  -- Blokada wiersza: dwa dotknięcia naraz (dwie karty, dwa telefony) idą po kolei,
  -- drugie widzi już zapłaconą fakturę.
  SELECT * INTO v_invoice
    FROM public.invoices
   WHERE id = p_invoice_id AND tenant_id = v_tenant_id
   FOR UPDATE;
  -- Faktura obcej firmy wygląda jak brak faktury: bez informacji, że istnieje.
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_found');
  END IF;
  IF v_invoice.direction IS DISTINCT FROM 'outgoing' THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_sales', 'internal_number', v_invoice.internal_number);
  END IF;
  IF v_invoice.ksef_status IS DISTINCT FROM 'accepted' THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_accepted', 'internal_number', v_invoice.internal_number);
  END IF;

  v_paid_on := COALESCE(p_paid_on, v_today);
  IF v_paid_on > v_today THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'future_date', 'internal_number', v_invoice.internal_number);
  END IF;
  -- Literówka w roku w polu daty (0202 zamiast 2026) nie jest datą zapłaty.
  IF v_paid_on < DATE '2000-01-01' THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_date', 'internal_number', v_invoice.internal_number);
  END IF;

  -- Do zapłaty liczone jak w update_invoice_payment_status (00145)
  -- i `lib/invoices/amount-due.ts`: ROZ płaci resztę po zaliczkach.
  IF v_invoice.invoice_kind = 'final'
     AND v_invoice.gross_total IS NOT NULL
     AND (v_invoice.payment_data ->> 'amountDue') ~ '^[0-9]+(\.[0-9]+)?$'
  THEN
    v_due := LEAST((v_invoice.payment_data ->> 'amountDue')::numeric, v_invoice.gross_total);
  ELSE
    v_due := v_invoice.gross_total;
  END IF;

  -- `Zaplacono = 1` + `DataZaplaty` z FA(3): faktura wystawiona po zapłacie (import
  -- pliku, historia KSeF). Druga wpłata przesunęłaby wpływ na dzień oznaczenia.
  IF v_invoice.payment_status = 'paid'
     OR (v_invoice.fa3_data -> 'parsed' ->> 'paidDate') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     OR (v_invoice.invoice_kind = 'final' AND v_due = 0)
     OR (v_due > 0 AND v_invoice.paid_amount >= v_due)
  THEN
    RETURN jsonb_build_object('status', 'already_paid', 'internal_number', v_invoice.internal_number);
  END IF;

  -- Korekta in minus albo dokument bez kwoty: nikt tu nic nie płaci.
  IF v_due IS NULL OR v_due <= 0 THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'nothing_to_pay', 'internal_number', v_invoice.internal_number);
  END IF;
  v_rest := v_due - v_invoice.paid_amount;

  -- Faktura skorygowana do zera: w KSeF nie ma anulowania, to korekta. Nabywca nic
  -- nie jest winien, a wpłata i korekta dałyby na Przepływach dwa fałszywe ruchy.
  -- Korekta częściowa nie blokuje: wpłata jest na resztę tej faktury, a korekta
  -- to osobny ruch w dniu jej wystawienia (`lib/dashboard/inflows.ts`).
  SELECT COALESCE(SUM(c.gross_total), 0) INTO v_corrections
    FROM public.invoices AS c
   WHERE c.tenant_id = v_tenant_id
     AND c.parent_invoice_id = p_invoice_id
     AND c.ksef_status = 'accepted';
  IF v_rest + v_corrections <= 0 THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'corrected_to_zero', 'internal_number', v_invoice.internal_number);
  END IF;

  INSERT INTO public.payments (
    tenant_id, invoice_id, amount, payment_date, payment_method,
    is_confirmed, match_method, notes
  ) VALUES (
    v_tenant_id, p_invoice_id, v_rest, v_paid_on, 'other',
    true, 'manual', 'Oznaczone jako zapłacone przez klienta'
  )
  RETURNING id INTO v_payment_id;

  -- Wyzwalacze ustawiły właśnie paid_at = now(). Przy innej dacie wpływ ma trafić
  -- w dzień wybrany przez klienta; południe w Warszawie, żeby żadna zmiana czasu
  -- nie przesunęła go na sąsiedni dzień (`inflowDay` liczy dzień w Warszawie).
  IF v_paid_on <> v_today THEN
    UPDATE public.invoices
       SET paid_at = (v_paid_on + TIME '12:00') AT TIME ZONE 'Europe/Warsaw'
     WHERE id = p_invoice_id AND tenant_id = v_tenant_id;
  END IF;

  -- W tej samej transakcji: job send-reminder sprawdza status tuż przed wysyłką
  -- (`lib/jobs/runners/send-reminder.ts`), więc nie wyśle ponaglenia za zapłaconą fakturę.
  UPDATE public.payment_reminders
     SET status = 'cancelled',
         failure_reason = 'Faktura oznaczona jako zapłacona'
   WHERE tenant_id = v_tenant_id
     AND invoice_id = p_invoice_id
     AND status = 'pending';
  GET DIAGNOSTICS v_reminders = ROW_COUNT;

  RETURN jsonb_build_object(
    'status', 'marked',
    'payment_id', v_payment_id,
    'amount', v_rest,
    'paid_on', v_paid_on,
    'reminders_cancelled', v_reminders,
    'internal_number', v_invoice.internal_number
  );
END;
$$;

COMMENT ON FUNCTION public.mark_invoice_paid(uuid, date) IS
  'Oznacza fakturę sprzedaży przyjętą w KSeF jako zapłaconą: wpłata na całą resztę '
  '(match_method = manual), anulowanie oczekujących przypomnień. Idempotentne.';

-- Cofnięcie usuwa wyłącznie wpłatę ręczną. Wpłaty z banku i z FLO zostają,
-- a faktura z taką wpłatą wraca do stanu `partial`.
--
-- Przypomnienia: oznaczenie anuluje tylko wiersze `pending`, a te powstają przy
-- wysyłce zatwierdzonej przez człowieka i żyją sekundy (`payment-chase-handler`).
-- Powrót do `pending` zostawiłby wiersz bez joba, gdy job zdążył już je pominąć:
-- utknąłby na stałe i zablokował etap. Dlatego etap zwalniamy, a przypomnienie
-- planuje od nowa harmonogram (`reminder-scheduler`, `decideNextReminder`
-- patrzy tylko na `pending` i `sent`), z nową zgodą człowieka. Trzeba usunąć dwie
-- rzeczy, które trzymają etap: wiersz (UNIQUE (invoice_id, stage)) i zlecenie
-- w zgodzie (`hasReminderDispatch`). Bez zlecenia stara zgoda nic już nie wyśle:
-- job z kolejki kończy się na `readReminderDispatch`, więc wysyłki dwa razy nie ma.
-- Wysyłka z potwierdzeniem dostawy (`reminderReceipt`) zostaje w całości: mail
-- wyszedł, a job zaraz zapisze wierszowi `sent`, więc etapu nie wolno oddać.
CREATE OR REPLACE FUNCTION public.undo_invoice_paid(p_invoice_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  v_amount numeric;
  v_paid_on date;
  v_reminders integer;
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

  PERFORM 1 FROM public.invoices
    WHERE id = p_invoice_id AND tenant_id = v_tenant_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_found');
  END IF;

  DELETE FROM public.payments
   WHERE tenant_id = v_tenant_id
     AND invoice_id = p_invoice_id
     AND match_method = 'manual'
  RETURNING amount, payment_date INTO v_amount, v_paid_on;
  -- Drugie dotknięcie „Cofnij” albo wpłata z banku lub z FLO: nie ma czego cofać.
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'nothing_to_undo');
  END IF;

  WITH freed AS (
    DELETE FROM public.payment_reminders AS r
     WHERE r.tenant_id = v_tenant_id
       AND r.invoice_id = p_invoice_id
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
               'reason', 'undo_invoice_paid'
             )
           )
      FROM freed
     WHERE a.id = freed.id
       AND a.tenant_id = v_tenant_id
       AND a.snapshot ? 'reminderDispatch'
    RETURNING a.id
  )
  SELECT count(*) INTO v_reminders FROM freed;

  RETURN jsonb_build_object(
    'status', 'undone',
    'amount', v_amount,
    'paid_on', v_paid_on,
    'reminders_restored', v_reminders
  );
END;
$$;

COMMENT ON FUNCTION public.undo_invoice_paid(uuid) IS
  'Cofa wyłącznie wpłatę ręczną z mark_invoice_paid; zwalnia etapy przypomnień '
  'anulowane tym oznaczeniem, które planuje od nowa harmonogram.';

-- `payments` nie ma odczytu dla sesji (00074), a szczegóły faktury muszą wiedzieć,
-- czy pokazać „Cofnij zapłatę”. Sama data i kwota wpłaty ręcznej tej firmy,
-- bez dostępu do reszty tabeli (dane rachunku płatnika, wpłaty z banku).
CREATE OR REPLACE FUNCTION public.invoice_manual_payment(p_invoice_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object('amount', p.amount, 'paid_on', p.payment_date)
    FROM public.payments AS p
   WHERE p.tenant_id = public.get_current_tenant_id()
     AND p.invoice_id = p_invoice_id
     AND p.match_method = 'manual';
$$;

COMMENT ON FUNCTION public.invoice_manual_payment(uuid) IS
  'Dzień i kwota wpłaty ręcznej faktury aktywnej firmy; NULL, gdy jej nie ma.';

-- Supabase nadaje EXECUTE rolom anon i authenticated jawnie, samo FROM PUBLIC nic
-- nie odbiera (AUD-30). Tylko sesja zalogowanego: klucz serwisowy nie ma auth.uid().
REVOKE ALL ON FUNCTION public.mark_invoice_paid(uuid, date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_invoice_paid(uuid, date) TO authenticated;
REVOKE ALL ON FUNCTION public.undo_invoice_paid(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.undo_invoice_paid(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.invoice_manual_payment(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.invoice_manual_payment(uuid) TO authenticated;
