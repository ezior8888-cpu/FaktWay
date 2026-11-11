-- ═══════════════════════════════════════════════════════════════
-- 00179: link do faktury dla nabywcy (plan kompletnej aplikacji, krok 2.10)
--
-- KIEDY WGRAĆ: PRZED wdrożeniem. Nowa tabela i nowe funkcje; bez DROP tabel
-- i kolumn, bez zmiany istniejących danych. Stary kod tabeli nie zna.
--
-- Firma tworzy dla faktury sprzedaży z FaktWay, przyjętej w KSeF (faktura VAT
-- albo zaliczkowa, z zapisanym plikiem XML), link do strony `/faktura/<token>`,
-- który wysyła nabywcy. W bazie jest tylko skrót SHA-256 tokenu (64 znaki hex),
-- nigdy sam token. Link żyje do `expires_at` (domyślnie i najwyżej 90 dni)
-- albo do cofnięcia (`revoked_at`, jednokierunkowo). Na fakturę najwyżej jeden
-- link niecofnięty; nowy link aplikacja tworzy po cofnięciu poprzedniego.
--
-- Kto: firma widzi swoje linki (RLS po `get_current_tenant_id()`), tworzy je
-- i cofa właściciel, administrator i członek zespołu (księgowa tylko czyta).
-- Klient zapisuje wyłącznie firmę, fakturę i skrót (INSERT) albo cofnięcie
-- (UPDATE revoked_at); termin, licznik i autora ustawia baza. Skrót tokenu
-- nie jest czytelny dla klienta (GRANT SELECT bez `token_hash`).
--
-- Odczyt publiczny tylko przez `invoice_share_link_view` (SECURITY DEFINER,
-- search_path = ''), wykonywaną wyłącznie kluczem serwisowym przez stronę
-- `/faktura/<token>` po limicie prób w Redisie: po skrócie tokenu zwraca dane
-- tej jednej faktury, gdy link żyje i faktura nadal spełnia warunki, inaczej
-- NULL (bez rozróżnienia powodu). Wybiera pola dokumentu wprost: bez e-maili,
-- telefonów, PESEL-u, statusu płatności i reszty `fa3_data`.
-- ═══════════════════════════════════════════════════════════════

-- Warunek faktury, dla której wolno dać link. SECURITY INVOKER: w polityce
-- INSERT czyta faktury i pliki XML z prawami klienta (RLS), w funkcji odczytu
-- publicznego z prawami jej właściciela.
CREATE OR REPLACE FUNCTION public.invoice_shareable(p_tenant_id UUID, p_invoice_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.invoices i
      JOIN public.xml_documents x
        ON x.tenant_id = i.tenant_id
       AND x.invoice_id = i.id
       AND x.storage_path = i.xml_storage_path
     WHERE i.tenant_id = p_tenant_id
       AND i.id = p_invoice_id
       AND i.direction = 'outgoing'
       AND i.origin = 'app'
       AND i.ksef_status = 'accepted'
       AND i.invoice_kind::text IN ('regular', 'advance')
       AND NULLIF(pg_catalog.btrim(i.ksef_number), '') IS NOT NULL
       AND x.sha256_hash ~* '^[0-9a-f]{64}$'
  );
$$;

REVOKE ALL ON FUNCTION public.invoice_shareable(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invoice_shareable(UUID, UUID) TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.invoice_share_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL,
  -- SHA-256 tokenu z adresu, szesnastkowo; token zna tylko adres wysłany nabywcy.
  token_hash TEXT NOT NULL,
  created_by UUID DEFAULT auth.uid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '90 days'),
  revoked_at TIMESTAMPTZ,
  revoked_by UUID,
  -- Otwarcia strony (pobrania plików się nie liczą); bez adresów IP nabywcy.
  open_count INTEGER NOT NULL DEFAULT 0,
  last_opened_at TIMESTAMPTZ,
  CONSTRAINT invoice_share_links_token_hash_key UNIQUE (token_hash),
  CONSTRAINT invoice_share_links_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT invoice_share_links_expires_check CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '90 days'
  ),
  CONSTRAINT invoice_share_links_open_count_check CHECK (open_count >= 0),
  -- Klucz złożony: link firmy A nie wskaże faktury firmy B (indeks z 00073).
  CONSTRAINT invoice_share_links_invoice_fk FOREIGN KEY (tenant_id, invoice_id)
    REFERENCES public.invoices (tenant_id, id) ON DELETE CASCADE
);

-- Najwyżej jeden link niecofnięty na fakturę (także wygasły, dopóki nie cofnięty).
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_share_links_live
  ON public.invoice_share_links (tenant_id, invoice_id)
  WHERE revoked_at IS NULL;

-- Ostatni link faktury (panel w karcie faktury) i kaskada przy usunięciu faktury.
CREATE INDEX IF NOT EXISTS idx_invoice_share_links_invoice
  ON public.invoice_share_links (tenant_id, invoice_id, created_at DESC);

-- Link jest niezmienny poza cofnięciem i licznikiem otwarć; cofnięcie jest
-- jednokierunkowe, a jego czas i autora ustawia baza.
CREATE OR REPLACE FUNCTION public.guard_invoice_share_link()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'invoice_share_link_immutable' USING ERRCODE = '42501';
  END IF;

  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'invoice_share_link_revoked' USING ERRCODE = '42501';
  END IF;

  IF NEW.revoked_at IS NOT NULL THEN
    NEW.revoked_at := pg_catalog.now();
    NEW.revoked_by := auth.uid();
  ELSIF NEW.revoked_by IS NOT NULL THEN
    RAISE EXCEPTION 'invoice_share_link_immutable' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_invoice_share_link() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_invoice_share_link ON public.invoice_share_links;
CREATE TRIGGER guard_invoice_share_link
  BEFORE UPDATE ON public.invoice_share_links
  FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_share_link();

ALTER TABLE public.invoice_share_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "invoice_share_links_select_own_tenant" ON public.invoice_share_links;
CREATE POLICY "invoice_share_links_select_own_tenant" ON public.invoice_share_links
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_current_tenant_id());

DROP POLICY IF EXISTS "invoice_share_links_insert_editor" ON public.invoice_share_links;
CREATE POLICY "invoice_share_links_insert_editor" ON public.invoice_share_links
  FOR INSERT TO authenticated
  WITH CHECK (
    tenant_id = public.get_current_tenant_id()
    AND (
      public.has_org_role(tenant_id, 'owner')
      OR public.has_org_role(tenant_id, 'admin')
      OR public.has_org_role(tenant_id, 'member')
    )
    AND public.invoice_shareable(tenant_id, invoice_id)
  );

DROP POLICY IF EXISTS "invoice_share_links_revoke_editor" ON public.invoice_share_links;
CREATE POLICY "invoice_share_links_revoke_editor" ON public.invoice_share_links
  FOR UPDATE TO authenticated
  USING (
    tenant_id = public.get_current_tenant_id()
    AND revoked_at IS NULL
    AND (
      public.has_org_role(tenant_id, 'owner')
      OR public.has_org_role(tenant_id, 'admin')
      OR public.has_org_role(tenant_id, 'member')
    )
  )
  WITH CHECK (
    tenant_id = public.get_current_tenant_id()
    AND revoked_at IS NOT NULL
  );

REVOKE ALL ON public.invoice_share_links FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT (
  id, tenant_id, invoice_id, created_by, created_at, expires_at,
  revoked_at, revoked_by, open_count, last_opened_at
) ON public.invoice_share_links TO authenticated;
GRANT INSERT (tenant_id, invoice_id, token_hash) ON public.invoice_share_links TO authenticated;
GRANT UPDATE (revoked_at) ON public.invoice_share_links TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoice_share_links TO service_role;

-- Odczyt publiczny: dane jednej faktury po skrócie tokenu albo NULL.
-- `p_count_open`: otwarcie strony liczy się do `open_count`, pobranie pliku nie.
CREATE OR REPLACE FUNCTION public.invoice_share_link_view(
  p_token_hash TEXT,
  p_count_open BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_link_id UUID;
  v_tenant_id UUID;
  v_invoice_id UUID;
  v_expires_at TIMESTAMPTZ;
  v_result JSONB;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;

  SELECT l.id, l.tenant_id, l.invoice_id, l.expires_at
    INTO v_link_id, v_tenant_id, v_invoice_id, v_expires_at
    FROM public.invoice_share_links l
   WHERE l.token_hash = p_token_hash
     AND l.revoked_at IS NULL
     AND l.expires_at > pg_catalog.now();

  IF v_link_id IS NULL OR NOT public.invoice_shareable(v_tenant_id, v_invoice_id) THEN
    RETURN NULL;
  END IF;

  SELECT pg_catalog.jsonb_build_object(
    'link_id', v_link_id,
    'tenant_id', i.tenant_id,
    'invoice_id', i.id,
    'expires_at', v_expires_at,
    'ksef_environment', i.ksef_environment,
    'xml_storage_path', i.xml_storage_path,
    'xml_sha256', pg_catalog.lower(x.sha256_hash),
    'invoice', pg_catalog.jsonb_build_object(
      'internal_number', i.internal_number,
      'invoice_type', i.invoice_type,
      'invoice_kind', i.invoice_kind::text,
      'issue_date', i.issue_date,
      'sale_date', i.sale_date,
      'currency', i.currency,
      'net_total', i.net_total,
      'vat_total', i.vat_total,
      'gross_total', i.gross_total,
      'notes', i.notes,
      'ksef_number', i.ksef_number,
      'ksef_accepted_at', i.ksef_accepted_at,
      'split_payment', COALESCE(i.fa3_data -> 'annotations' -> 'splitPayment' = '1'::jsonb, false),
      'seller', pg_catalog.jsonb_build_object(
        'name', i.seller_data ->> 'name',
        'nip', i.seller_data ->> 'nip',
        'address_line1', i.seller_data -> 'address' ->> 'addressLine1',
        'address_line2', i.seller_data -> 'address' ->> 'addressLine2',
        'country_code', i.seller_data -> 'address' ->> 'countryCode'
      ),
      'buyer', pg_catalog.jsonb_build_object(
        'name', i.buyer_data ->> 'name',
        'nip', i.buyer_data ->> 'nip',
        'vat_ue_number', i.buyer_data ->> 'vatUeNumber',
        'address_line1', i.buyer_data -> 'address' ->> 'addressLine1',
        'address_line2', i.buyer_data -> 'address' ->> 'addressLine2',
        'country_code', i.buyer_data -> 'address' ->> 'countryCode'
      ),
      'payment', pg_catalog.jsonb_build_object(
        'method', i.payment_data ->> 'method',
        'due_date', i.payment_data ->> 'dueDate',
        'bank_account', i.payment_data ->> 'bankAccount',
        'bank_name', i.payment_data ->> 'bankName',
        'swift', i.payment_data ->> 'swift'
      ),
      'lines', COALESCE((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'ordinal', li.ordinal,
          'name', li.name,
          'unit', li.unit,
          'quantity', li.quantity,
          'unit_price_net', li.unit_price_net,
          'vat_rate', li.vat_rate,
          'net_amount', li.net_amount,
          'vat_amount', li.vat_amount,
          'gross_amount', li.gross_amount
        ) ORDER BY li.ordinal)
          FROM public.invoice_line_items li
         WHERE li.invoice_id = i.id
      ), '[]'::jsonb)
    )
  )
    INTO v_result
    FROM public.invoices i
    JOIN public.xml_documents x
      ON x.tenant_id = i.tenant_id
     AND x.invoice_id = i.id
     AND x.storage_path = i.xml_storage_path
   WHERE i.tenant_id = v_tenant_id
     AND i.id = v_invoice_id;

  IF v_result IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_count_open THEN
    UPDATE public.invoice_share_links
       SET open_count = open_count + 1,
           last_opened_at = pg_catalog.now()
     WHERE id = v_link_id
       AND revoked_at IS NULL;
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.invoice_share_link_view(TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_share_link_view(TEXT, BOOLEAN) TO service_role;

COMMENT ON TABLE public.invoice_share_links IS
  'Linki do faktury dla nabywcy (krok 2.10): tylko skrót tokenu, termin do 90 dni, cofnięcie jednokierunkowe, odczyt publiczny przez invoice_share_link_view.';

NOTIFY pgrst, 'reload schema';
