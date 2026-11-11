-- ═══════════════════════════════════════════════════════════════
-- 00182: adres kalendarza klienta (plan docs/koordynacja/PLAN-KOMPLETNA-APLIKACJA.md,
-- krok 7.3)
--
-- KIEDY WGRAĆ: PRZED wdrożeniem. Nowa tabela i funkcja; bez DROP tabel
-- i kolumn, bez zmiany istniejących danych. Bez tabeli aplikacja pokazuje
-- błąd przy tworzeniu adresu, a trasa kalendarza odpowiada 503 (nie 404),
-- więc klient kalendarza nie uzna adresu za martwy.
--
-- Jedna firma, jeden aktywny adres: `tenant_id` jest kluczem głównym, więc
-- wymiana adresu to nadpisanie skrótu (stary przestaje działać od razu),
-- a usunięcie to DELETE. W bazie jest wyłącznie skrót SHA-256 (hex) tokenu
-- o 256 bitach; sam token widać raz, w odpowiedzi akcji.
--
-- Odczyt publiczny (trasa bez sesji) tylko przez `calendar_feed_tenant`:
-- SECURITY DEFINER, `search_path = ''`, EXECUTE wyłącznie dla service_role.
-- Anon i authenticated nie wywołają jej z PostgREST, więc nie da się
-- zgadywać skrótów przez API bazy.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.calendar_feed_tokens (
  tenant_id UUID PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_by UUID DEFAULT auth.uid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT calendar_feed_tokens_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$')
);

ALTER TABLE public.calendar_feed_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "calendar_feed_tokens_select_owner_admin" ON public.calendar_feed_tokens;
CREATE POLICY "calendar_feed_tokens_select_owner_admin" ON public.calendar_feed_tokens
  FOR SELECT TO authenticated
  USING (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
  );

DROP POLICY IF EXISTS "calendar_feed_tokens_insert_owner_admin" ON public.calendar_feed_tokens;
CREATE POLICY "calendar_feed_tokens_insert_owner_admin" ON public.calendar_feed_tokens
  FOR INSERT TO authenticated
  WITH CHECK (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
  );

DROP POLICY IF EXISTS "calendar_feed_tokens_update_owner_admin" ON public.calendar_feed_tokens;
CREATE POLICY "calendar_feed_tokens_update_owner_admin" ON public.calendar_feed_tokens
  FOR UPDATE TO authenticated
  USING (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
  )
  WITH CHECK (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
  );

DROP POLICY IF EXISTS "calendar_feed_tokens_delete_owner_admin" ON public.calendar_feed_tokens;
CREATE POLICY "calendar_feed_tokens_delete_owner_admin" ON public.calendar_feed_tokens
  FOR DELETE TO authenticated
  USING (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
  );

REVOKE ALL ON public.calendar_feed_tokens FROM PUBLIC, anon, authenticated, service_role;
-- Skrót tokenu jest tylko do zapisu: odczyt dla klienta obejmuje datę i autora, nie skrót.
GRANT SELECT (tenant_id, created_by, created_at) ON public.calendar_feed_tokens TO authenticated;
GRANT INSERT (tenant_id, token_hash, created_by, created_at) ON public.calendar_feed_tokens TO authenticated;
GRANT UPDATE (token_hash, created_by, created_at) ON public.calendar_feed_tokens TO authenticated;
GRANT DELETE ON public.calendar_feed_tokens TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.calendar_feed_tokens TO service_role;

-- Firma dla skrótu tokenu albo NULL (nieznany, usunięty, wymieniony).
CREATE OR REPLACE FUNCTION public.calendar_feed_tenant(p_token_hash TEXT)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT t.tenant_id
  FROM public.calendar_feed_tokens t
  WHERE t.token_hash = p_token_hash
$$;

REVOKE ALL ON FUNCTION public.calendar_feed_tenant(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.calendar_feed_tenant(TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';
