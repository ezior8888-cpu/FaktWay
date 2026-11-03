-- 00163_access_grant_code_step.sql
--
-- Krok kodu przy dostępie osób trzecich także w bazie (FaktWay 1.0, recenzja #359).
--
-- Akcje serwerowe pytają o kod z aplikacji (`requireCodeForAccessGrant`,
-- lib/auth/access-grant-mfa.ts), gdy konto ma zweryfikowany czynnik 2FA, a sesja
-- kodu nie podała. Taką sesję (AAL1) daje logowanie biometrią, a jej token działa
-- też wprost w PostgREST. Do tej pory dało się więc obejść akcje:
--   * `accountant_settings` (00024): zapisać mógł KAŻDY członek firmy, bez roli
--     i bez kodu, czyli skierować comiesięczną paczkę JPK i KPiR na obcy adres;
--   * `accountant_access` (00037): właściciel wystawiał, przedłużał i przywracał
--     link dla księgowej bez kodu;
--   * RPC `approve_join_request` (00103) i `change_membership_role` (00038):
--     przyjęcie prośby o dostęp i zmiana roli, także na właściciela, bez kodu.
--
-- Zmiana:
--   * `session_may_grant_access()`: ten sam warunek co akcje, czyli AAL2 albo konto
--     bez zweryfikowanego czynnika (jak `session_may_manage_passkeys` z 00159);
--   * polityki RESTRICTIVE obok istniejących: ustawienia księgowej zapisuje i usuwa
--     tylko właściciel albo administrator (jak `updateAccountantSettingsAction`),
--     zapis dodatkowo z kodem; link dla księgowej wystawia się z kodem, a zmiana
--     linku wymaga kodu, chyba że po niej link jest cofnięty (`revoked_at`), bo
--     cofnięcie (`revokeAccountantTokenAction`) kodu nie wymaga;
--   * oba RPC odmawiają przed zapisem: `code_step_required` (42501). Reszta ciał
--     bez zmian: 00103 i 00038.
--
-- PRZED wdrożeniem albo bez wdrożenia: działający kod pyta o kod przed każdym
-- z tych zapisów, więc niczego nie traci. Odczyt bez zmian. Bez DROP i bez zmian
-- danych. Po wgraniu: NOTIFY pgrst + schema_migrations (AGENTS.md, „Wgrywanie
-- migracji”). Wycofanie: DROP POLICY czterech polityk i ciała RPC z 00103 i 00038.

BEGIN;

-- Oddaje jeden bit o własnym koncie, nic więcej. `authenticated` nie ma odczytu
-- `auth.mfa_factors`, stąd SECURITY DEFINER.
CREATE FUNCTION public.session_may_grant_access()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
    OR NOT EXISTS (
      SELECT 1 FROM auth.mfa_factors factor
      WHERE factor.user_id = auth.uid() AND factor.status = 'verified'
    );
$$;

REVOKE ALL ON FUNCTION public.session_may_grant_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.session_may_grant_access() TO authenticated, service_role;

-- ─── accountant_settings ───────────────────────────────────────
-- Odczyt i izolację firm zostawia `accountant_settings_tenant_isolation` (00024).
CREATE POLICY accountant_settings_insert_owner_admin_code ON public.accountant_settings
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (
    (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
    AND public.session_may_grant_access()
  );

CREATE POLICY accountant_settings_update_owner_admin_code ON public.accountant_settings
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
  WITH CHECK (
    (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
    AND public.session_may_grant_access()
  );

CREATE POLICY accountant_settings_delete_owner_admin ON public.accountant_settings
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'));

-- ─── accountant_access ─────────────────────────────────────────
-- Rolę (tylko właściciel) sprawdza dalej `accountant_access_owner_manage` (00037).
-- Portal księgowej odrzuca każdy wiersz z `revoked_at`, więc cofnięty link nic nie daje.
CREATE POLICY accountant_access_insert_code ON public.accountant_access
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.session_may_grant_access());

CREATE POLICY accountant_access_update_code_unless_revoked ON public.accountant_access
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (true)
  WITH CHECK (revoked_at IS NOT NULL OR public.session_may_grant_access());

-- ─── approve_join_request (ciało z 00103 + krok kodu) ───────────
CREATE OR REPLACE FUNCTION public.approve_join_request(
  p_request_id UUID,
  p_role TEXT DEFAULT 'member'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_req RECORD;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'unauthenticated';
  END IF;

  IF p_role NOT IN ('owner', 'admin', 'member', 'accountant') THEN
    RAISE EXCEPTION 'invalid_role';
  END IF;

  SELECT * INTO v_req
  FROM public.organization_join_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'request_not_found';
  END IF;

  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'request_already_decided';
  END IF;

  -- Zatwierdzić może owner lub admin org.
  IF NOT (
    public.has_org_role(v_req.organization_id, 'owner')
    OR public.has_org_role(v_req.organization_id, 'admin')
  ) THEN
    RAISE EXCEPTION 'insufficient_role';
  END IF;

  -- Rolę właściciela nadaje tylko właściciel (AUD-29). Admin, który
  -- zatwierdziłby własne drugie konto jako owner, mógłby potem usunąć
  -- prawdziwego właściciela.
  IF p_role = 'owner' AND NOT public.has_org_role(v_req.organization_id, 'owner') THEN
    RAISE EXCEPTION 'insufficient_role';
  END IF;

  -- Przyjęcie prośby oddaje dostęp osobie trzeciej: sesja bez kodu na koncie
  -- z 2FA (00163, ten sam warunek co `approveJoinRequestAction`).
  IF NOT public.session_may_grant_access() THEN
    RAISE EXCEPTION 'code_step_required' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.memberships (organization_id, user_id, role, status, invited_by, joined_at)
  VALUES (v_req.organization_id, v_req.requested_by_user_id, p_role, 'active', v_user, now())
  ON CONFLICT (organization_id, user_id)
  DO UPDATE SET status = 'active', role = EXCLUDED.role, revoked_at = NULL, joined_at = now();

  UPDATE public.organization_join_requests
  SET status = 'approved', decided_by = v_user, decided_at = now()
  WHERE id = p_request_id;

  RETURN v_req.organization_id;
END;
$$;

-- ─── change_membership_role (ciało z 00038 + krok kodu) ─────────
CREATE OR REPLACE FUNCTION public.change_membership_role(
  p_membership_id UUID,
  p_new_role TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_mem RECORD;
  v_owner_count INT;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'unauthenticated';
  END IF;

  IF p_new_role NOT IN ('owner', 'admin', 'member', 'accountant') THEN
    RAISE EXCEPTION 'invalid_role';
  END IF;

  SELECT * INTO v_mem
  FROM public.memberships
  WHERE id = p_membership_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'membership_not_found';
  END IF;

  -- Tylko owner może zmieniać role.
  IF NOT public.has_org_role(v_mem.organization_id, 'owner') THEN
    RAISE EXCEPTION 'insufficient_role';
  END IF;

  -- Zmiana roli (także na właściciela) oddaje uprawnienia: sesja bez kodu na
  -- koncie z 2FA (00163, ten sam warunek co `changeMembershipRoleAction`).
  IF NOT public.session_may_grant_access() THEN
    RAISE EXCEPTION 'code_step_required' USING ERRCODE = '42501';
  END IF;

  -- Demotion ostatniego ownera blokujemy.
  IF v_mem.role = 'owner' AND p_new_role <> 'owner' AND v_mem.status = 'active' THEN
    SELECT COUNT(*) INTO v_owner_count
    FROM public.memberships
    WHERE organization_id = v_mem.organization_id
      AND role = 'owner'
      AND status = 'active'
      AND id <> p_membership_id;

    IF v_owner_count = 0 THEN
      RAISE EXCEPTION 'cannot_demote_last_owner';
    END IF;
  END IF;

  UPDATE public.memberships SET role = p_new_role WHERE id = p_membership_id;
END;
$$;

COMMIT;
