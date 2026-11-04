-- 00152_billing_invoice_faktway_name.sql
--
-- Zmiana nazwy produktu FaktFlow → FaktWay (17.10.2026): faktura VAT za
-- abonament ma nosić nazwę FaktWay. `create_billing_vat_invoice` (00110)
-- porównywała nazwę pozycji i uwagi z napisem „FaktFlow” co do znaku, więc
-- kod z nową nazwą dostawał odmowę, a klient płacący kartą — brak faktury.
--
-- Funkcja przyjmuje teraz OBA warianty nazwy:
--   • pozycja: „FaktFlow|FaktWay — subskrypcja miesięczna|roczna (…)”,
--   • uwagi: „Faktura za subskrypcję FaktFlow|FaktWay. Płatność Stripe: in_….”
--     — zapisane takie, jakie przysłał kod (dotąd baza wpisywała ten sam
--     napis ze swojej stałej),
--   • ponowienie (płatność ma już fakturę): treść porównana bez nazwy
--     produktu — faktura wystawiona jako FaktFlow i ponowiona jako FaktWay
--     (albo odwrotnie) zwraca TĘ SAMĄ fakturę, bez drugiej i bez nowego
--     numeru; wystawiony dokument się nie zmienia. Każda inna różnica nadal
--     wymaga uzgodnienia,
--   • dawna faktura bez powiązania z płatnością: szukana po uwagach w obu
--     nazwach.
-- Reszta funkcji bez zmian (00110).
--
-- PRZED wdrożeniem, addytywna: CREATE OR REPLACE jednej funkcji, bez zmian
-- danych. Kod sprzed wdrożenia (FaktFlow) działa na nowej funkcji bez zmian;
-- kod po wdrożeniu (FaktWay) wymaga tej migracji. Wgrywa właściciel funkcji
-- (`postgres`), nie `service_role` (00079).

CREATE OR REPLACE FUNCTION public.create_billing_vat_invoice(
  p_payment_id uuid,
  p_customer_tenant_id uuid,
  p_operator_tenant_id uuid,
  p_stripe_invoice_id text,
  p_invoice jsonb
)
RETURNS TABLE(invoice_id uuid, internal_number text, created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payment public.stripe_payments%ROWTYPE;
  v_subscription public.subscriptions%ROWTYPE;
  v_customer public.tenants%ROWTYPE;
  v_operator public.tenants%ROWTYPE;
  v_existing public.invoices%ROWTYPE;
  v_snapshot jsonb;
  v_line jsonb;
  v_paid_date date;
  v_number text;
  v_note text;
  v_note_faktflow text;
  v_note_faktway text;
  v_gross numeric;
  v_net numeric;
  v_vat numeric;
  v_stripe_customer text;
  v_legacy_subscription text;
  v_parent_subscription text;
  v_new_invoice_id uuid;
  v_rows integer;
  v_invoice jsonb;
  v_requested_neutral jsonb;
  v_existing_neutral jsonb;
  v_seq integer;
BEGIN
  IF p_payment_id IS NULL OR p_customer_tenant_id IS NULL
     OR p_operator_tenant_id IS NULL OR p_stripe_invoice_id IS NULL
     OR p_stripe_invoice_id !~ '^in_[A-Za-z0-9]{8,}$'
     OR pg_catalog.jsonb_typeof(p_invoice) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid billing invoice request' USING ERRCODE = '22023';
  END IF;

  SELECT p.* INTO v_payment
  FROM public.stripe_payments AS p
  WHERE p.id = p_payment_id AND p.tenant_id = p_customer_tenant_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment identity requires reconciliation'
      USING ERRCODE = '23514';
  END IF;
  IF v_payment.status IS DISTINCT FROM 'succeeded'
     OR v_payment.stripe_invoice_id IS DISTINCT FROM p_stripe_invoice_id
     OR v_payment.paid_at IS NULL
     OR v_payment.amount_cents <= 0
     OR pg_catalog.lower(v_payment.currency) <> 'pln'
     OR v_payment.subscription_id IS NULL THEN
    RAISE EXCEPTION 'Payment not eligible for automatic VAT invoice'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
      SELECT 1 FROM public.stripe_refund_operations AS o
      WHERE o.payment_id = v_payment.id
    ) OR EXISTS (
      SELECT 1 FROM public.stripe_refunds AS r
      WHERE r.payment_id = v_payment.id
    ) THEN
    RAISE EXCEPTION 'Refund requires VAT reconciliation'
      USING ERRCODE = '23514';
  END IF;

  SELECT s.* INTO v_subscription FROM public.subscriptions AS s
  WHERE s.id = v_payment.subscription_id AND s.tenant_id = v_payment.tenant_id;
  SELECT t.* INTO v_customer FROM public.tenants AS t
  WHERE t.id = p_customer_tenant_id;
  SELECT t.* INTO v_operator FROM public.tenants AS t
  WHERE t.id = p_operator_tenant_id;
  IF v_subscription.id IS NULL OR v_customer.id IS NULL OR v_operator.id IS NULL
     OR v_subscription.stripe_customer_id IS DISTINCT FROM v_customer.stripe_customer_id
     OR v_customer.stripe_customer_id IS NULL THEN
    RAISE EXCEPTION 'Billing customer binding requires reconciliation'
      USING ERRCODE = '23514';
  END IF;

  -- A paid invoice snapshot came from a verified webhook. Reject incomplete
  -- legacy snapshots rather than trusting a mutable subscription plan alone.
  v_snapshot := v_payment.last_webhook_payload;
  IF pg_catalog.jsonb_typeof(v_snapshot) IS DISTINCT FROM 'object'
     OR v_snapshot->>'id' IS DISTINCT FROM p_stripe_invoice_id
     OR v_snapshot->>'status' IS DISTINCT FROM 'paid'
     OR v_snapshot->>'currency' IS DISTINCT FROM 'pln'
     OR pg_catalog.jsonb_typeof(v_snapshot->'amount_paid') IS DISTINCT FROM 'number'
     OR (v_snapshot->>'amount_paid')::numeric IS DISTINCT FROM v_payment.amount_cents THEN
    RAISE EXCEPTION 'Paid Stripe snapshot requires reconciliation'
      USING ERRCODE = '23514';
  END IF;
  v_stripe_customer := CASE
    WHEN pg_catalog.jsonb_typeof(v_snapshot->'customer') = 'string'
      THEN v_snapshot->>'customer'
    ELSE v_snapshot#>>'{customer,id}'
  END;
  v_legacy_subscription := CASE
    WHEN pg_catalog.jsonb_typeof(v_snapshot->'subscription') = 'string'
      THEN v_snapshot->>'subscription'
    ELSE v_snapshot#>>'{subscription,id}'
  END;
  v_parent_subscription := CASE
    WHEN pg_catalog.jsonb_typeof(v_snapshot#>'{parent,subscription_details,subscription}') = 'string'
      THEN v_snapshot#>>'{parent,subscription_details,subscription}'
    ELSE v_snapshot#>>'{parent,subscription_details,subscription,id}'
  END;
  IF v_stripe_customer IS DISTINCT FROM v_subscription.stripe_customer_id
     OR (v_legacy_subscription IS NOT NULL AND v_parent_subscription IS NOT NULL
         AND v_legacy_subscription <> v_parent_subscription)
     OR COALESCE(v_legacy_subscription, v_parent_subscription)
        IS DISTINCT FROM v_subscription.stripe_subscription_id THEN
    RAISE EXCEPTION 'Stripe snapshot subscription/customer mismatch'
      USING ERRCODE = '23514';
  END IF;

  -- AUD-69: data według czasu polskiego — płatność 00:30 1 marca to marzec,
  -- nie luty (UTC). Numer nadaje baza niżej, kolejny w miesiącu.
  v_paid_date := (v_payment.paid_at AT TIME ZONE 'Europe/Warsaw')::date;
  -- 00152: nazwa produktu FaktFlow → FaktWay. Przyjmujemy obie (worker sprzed
  -- wdrożenia wysyła jeszcze starą) i zapisujemy tę, którą przysłał kod.
  v_note_faktflow := 'Faktura za subskrypcję FaktFlow. Płatność Stripe: '
    || p_stripe_invoice_id || '.';
  v_note_faktway := 'Faktura za subskrypcję FaktWay. Płatność Stripe: '
    || p_stripe_invoice_id || '.';
  v_note := p_invoice->>'notes';

  IF pg_catalog.jsonb_typeof(p_invoice->'lines') IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(p_invoice->'lines') <> 1
     OR pg_catalog.jsonb_typeof(p_invoice->'seller') IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(p_invoice->'buyer') IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(p_invoice->'payment') IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(p_invoice->'grossTotal') IS DISTINCT FROM 'number'
     OR pg_catalog.jsonb_typeof(p_invoice->'netTotal') IS DISTINCT FROM 'number'
     OR pg_catalog.jsonb_typeof(p_invoice->'vatTotal') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'Incomplete billing VAT draft' USING ERRCODE = '22023';
  END IF;
  v_line := p_invoice->'lines'->0;
  IF pg_catalog.jsonb_typeof(v_line) IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(v_line->'quantity') IS DISTINCT FROM 'number'
     OR pg_catalog.jsonb_typeof(v_line->'unitPriceNet') IS DISTINCT FROM 'number'
     OR pg_catalog.jsonb_typeof(v_line->'netAmount') IS DISTINCT FROM 'number'
     OR pg_catalog.jsonb_typeof(v_line->'vatAmount') IS DISTINCT FROM 'number'
     OR pg_catalog.jsonb_typeof(v_line->'grossAmount') IS DISTINCT FROM 'number'
     OR pg_catalog.jsonb_typeof(p_invoice->'payment'->'amountDue') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'Incomplete billing VAT line' USING ERRCODE = '22023';
  END IF;
  v_gross := (p_invoice->>'grossTotal')::numeric;
  v_net := (p_invoice->>'netTotal')::numeric;
  v_vat := (p_invoice->>'vatTotal')::numeric;
  IF v_gross <= 0 OR v_gross * 100 <> v_payment.amount_cents
     OR v_net + v_vat <> v_gross
     OR (v_line->>'grossAmount')::numeric <> v_gross
     OR (v_line->>'netAmount')::numeric <> v_net
     OR (v_line->>'vatAmount')::numeric <> v_vat
     OR (v_line->>'unitPriceNet')::numeric <> v_net
     OR (v_line->>'quantity')::numeric <> 1
     OR v_line->>'ordinal' IS DISTINCT FROM '1'
     OR v_net <> pg_catalog.round(v_gross / 1.23, 2)
     OR v_vat <> v_gross - v_net
     OR (p_invoice->'payment'->>'amountDue')::numeric <> v_gross
     OR COALESCE(v_line->>'unit', '') <> 'usł.'
     OR COALESCE(v_line->>'vatRate', '') <> '23'
     OR NOT (
       COALESCE(v_line->>'name', '') LIKE 'FaktWay — subskrypcja miesięczna (%'
       OR COALESCE(v_line->>'name', '') LIKE 'FaktWay — subskrypcja roczna (%'
       OR COALESCE(v_line->>'name', '') LIKE 'FaktFlow — subskrypcja miesięczna (%'
       OR COALESCE(v_line->>'name', '') LIKE 'FaktFlow — subskrypcja roczna (%'
     ) THEN
    RAISE EXCEPTION 'Billing VAT amount/line requires reconciliation'
      USING ERRCODE = '23514';
  END IF;
  IF COALESCE(v_note, '') NOT IN (v_note_faktflow, v_note_faktway)
     OR p_invoice->>'type' IS DISTINCT FROM 'VAT'
     OR p_invoice->>'issueDate' IS DISTINCT FROM v_paid_date::text
     OR p_invoice->>'saleDate' IS DISTINCT FROM v_paid_date::text
     OR p_invoice->'seller'->>'nip' IS DISTINCT FROM v_operator.nip
     OR p_invoice->'buyer'->>'nip' IS DISTINCT FROM v_customer.nip
     OR p_invoice->'payment'->>'currency' IS DISTINCT FROM 'PLN'
     OR p_invoice->'payment'->>'dueDate' IS DISTINCT FROM v_paid_date::text
     OR p_invoice->'payment'->>'method' IS DISTINCT FROM 'card' THEN
    RAISE EXCEPTION 'Billing VAT identity/date requires reconciliation'
      USING ERRCODE = '23514';
  END IF;

  IF v_payment.vat_invoice_id IS NOT NULL THEN
    SELECT i.* INTO v_existing FROM public.invoices AS i
    WHERE i.id = v_payment.vat_invoice_id;
    -- Istniejąca faktura ma już swój numer — porównujemy z nim.
    v_number := v_existing.internal_number;
    v_invoice := pg_catalog.jsonb_set(p_invoice, '{internalNumber}', pg_catalog.to_jsonb(v_number));
    -- 00152: ponowienie może przyjść z drugą nazwą produktu (wystawiona jako
    -- FaktFlow, ponowiona jako FaktWay albo odwrotnie). Porównujemy treść bez
    -- nazwy: w obu stronach nazwa pozycji i uwagi sprowadzone do FaktWay.
    -- Brak uwag albo pozycji w zapisanej fakturze daje NULL — różnicę.
    v_requested_neutral := pg_catalog.jsonb_set(
      pg_catalog.jsonb_set(v_invoice, '{notes}', pg_catalog.to_jsonb(v_note_faktway)),
      '{lines,0,name}',
      pg_catalog.to_jsonb(pg_catalog.regexp_replace(
        v_line->>'name', '^FaktFlow — ', 'FaktWay — ')));
    v_existing_neutral := pg_catalog.jsonb_set(
      pg_catalog.jsonb_set(v_existing.fa3_data, '{notes}', pg_catalog.to_jsonb(CASE
        WHEN v_existing.fa3_data->>'notes' = v_note_faktflow THEN v_note_faktway
        ELSE v_existing.fa3_data->>'notes'
      END)),
      '{lines,0,name}',
      pg_catalog.to_jsonb(pg_catalog.regexp_replace(
        v_existing.fa3_data#>>'{lines,0,name}', '^FaktFlow — ', 'FaktWay — ')));
    IF v_existing.id IS NULL
       OR v_existing.stripe_invoice_id IS DISTINCT FROM p_stripe_invoice_id
       OR v_existing.tenant_id IS DISTINCT FROM p_operator_tenant_id
       OR v_existing_neutral IS DISTINCT FROM v_requested_neutral
       OR (SELECT pg_catalog.count(*) FROM public.invoice_line_items AS li
           WHERE li.invoice_id = v_existing.id) <> 1
       OR NOT EXISTS (
         SELECT 1 FROM public.invoice_line_items AS li
         WHERE li.invoice_id = v_existing.id
           AND li.ordinal = 1
           AND pg_catalog.regexp_replace(li.name, '^FaktFlow — ', 'FaktWay — ')
             = pg_catalog.regexp_replace(v_line->>'name', '^FaktFlow — ', 'FaktWay — ')
           AND li.unit = v_line->>'unit'
           AND li.quantity = (v_line->>'quantity')::numeric
           AND li.unit_price_net = (v_line->>'unitPriceNet')::numeric
           AND li.net_amount = (v_line->>'netAmount')::numeric
           AND li.vat_rate = v_line->>'vatRate'
           AND li.vat_amount = (v_line->>'vatAmount')::numeric
           AND li.gross_amount = (v_line->>'grossAmount')::numeric
       ) THEN
      RAISE EXCEPTION 'Existing VAT invoice requires reconciliation'
        USING ERRCODE = '23514';
    END IF;
    RETURN QUERY SELECT v_existing.id, v_number, false;
    RETURN;
  END IF;

  -- Historical notes/fa3_data are customer-editable. Inspect only the
  -- configured operator tenant, so an unrelated tenant cannot block billing.
  -- 00152: dawna faktura mogła dostać uwagi w jednej z dwóch nazw produktu.
  IF EXISTS (
      SELECT 1 FROM public.invoices AS i
      WHERE i.tenant_id = p_operator_tenant_id
        AND (
          i.stripe_invoice_id = p_stripe_invoice_id
          OR i.notes IN (v_note_faktflow, v_note_faktway)
          OR i.fa3_data->>'notes' IN (v_note_faktflow, v_note_faktway)
        )
    ) THEN
    RAISE EXCEPTION 'Existing or legacy VAT invoice requires reconciliation'
      USING ERRCODE = '23514';
  END IF;

  -- AUD-69: kolejny numer w miesiącu (art. 106e ust. 1 pkt 2) zamiast końcówki
  -- identyfikatora Stripe. Licznik w tej samej transakcji — błąd niżej
  -- wycofuje i fakturę, i numer, więc numeracja nie ma dziur.
  INSERT INTO public.billing_invoice_counters AS c (operator_tenant_id, period, last_number)
  VALUES (p_operator_tenant_id, pg_catalog.to_char(v_paid_date, 'YYYY/MM'), 1)
  ON CONFLICT (operator_tenant_id, period)
    DO UPDATE SET last_number = c.last_number + 1
  RETURNING c.last_number INTO v_seq;
  v_number := 'FF/' || pg_catalog.to_char(v_paid_date, 'YYYY/MM') || '/'
    || pg_catalog.lpad(v_seq::text, 4, '0');
  v_invoice := pg_catalog.jsonb_set(p_invoice, '{internalNumber}', pg_catalog.to_jsonb(v_number));

  INSERT INTO public.invoices (
    tenant_id, direction, ksef_status, invoice_kind, origin,
    stripe_invoice_id, internal_number, invoice_type, issue_date, sale_date,
    seller_nip, buyer_nip, seller_data, buyer_data, payment_data,
    payment_due_date, currency, notes, net_total, vat_total, gross_total,
    is_b2c, fa3_data, payment_status, paid_amount
  ) VALUES (
    p_operator_tenant_id, 'outgoing', 'draft', 'regular', 'app',
    p_stripe_invoice_id, v_number, 'VAT', v_paid_date, v_paid_date,
    v_operator.nip, v_customer.nip, p_invoice->'seller', p_invoice->'buyer',
    p_invoice->'payment', v_paid_date, 'PLN', v_note, v_net, v_vat, v_gross,
    -- Abonament jest już opłacony kartą (AUD-69: dotąd „unpaid”).
    false, v_invoice, 'paid', v_gross
  ) RETURNING id INTO v_new_invoice_id;

  INSERT INTO public.invoice_line_items (
    invoice_id, ordinal, name, unit, quantity, unit_price_net,
    net_amount, vat_rate, vat_amount, gross_amount
  ) VALUES (
    v_new_invoice_id, 1, v_line->>'name', v_line->>'unit',
    (v_line->>'quantity')::numeric, (v_line->>'unitPriceNet')::numeric,
    (v_line->>'netAmount')::numeric, v_line->>'vatRate',
    (v_line->>'vatAmount')::numeric, (v_line->>'grossAmount')::numeric
  );

  UPDATE public.stripe_payments AS p
  SET vat_invoice_id = v_new_invoice_id
  WHERE p.id = v_payment.id AND p.tenant_id = p_customer_tenant_id
    AND p.status = 'succeeded' AND p.vat_invoice_id IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Payment changed during VAT invoice transaction'
      USING ERRCODE = '40001';
  END IF;

  -- Any error above aborts the PostgREST transaction, including header/line.
  -- This timestamp belongs to a confirmed KSeF enqueue, not draft creation.
  RETURN QUERY SELECT v_new_invoice_id, v_number, true;
END;
$$;

REVOKE ALL ON FUNCTION public.create_billing_vat_invoice(
  uuid, uuid, uuid, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_billing_vat_invoice(
  uuid, uuid, uuid, text, jsonb
) TO service_role;
