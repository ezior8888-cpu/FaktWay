-- ═══════════════════════════════════════════════════════════════
-- 00188: powiadomienia w aplikacji, czyli dzwonek w nagłówku (plan
-- docs/koordynacja/PLAN-KOMPLETNA-APLIKACJA.md, krok 8.1, część 2)
--
-- KIEDY WGRAĆ: PRZED wdrożeniem. Nowa tabela i dwie funkcje; bez DROP tabel
-- i kolumn, bez zmiany istniejących danych. Bez tej migracji dzwonek pokazuje
-- „Nie udało się wczytać powiadomień”, joby skrzynki i terminów zapisują błąd
-- do logu i działają dalej, a kolejki dzwonka wyczerpują ponowienia.
--
-- 1. app_notifications: skrzynka powiadomień. Jeden wiersz na ODBIORCĘ: zadanie
--    (service_role) woła app_notification_publish(), która dopisuje wpis każdemu
--    aktywnemu członkowi firmy. Data przeczytania jest więc osobna dla każdej
--    osoby: właściciel, który przeczytał, nie gasi powiadomienia księgowej.
--    Klucz idempotencji: UNIQUE (odbiorca, firma, rodzaj, klucz obiektu) i ON
--    CONFLICT DO NOTHING, więc ponowienie joba od zera nie dubluje wpisu.
--    Rodzaje: nowa faktura zakupu ze skrzynki KSeF, faktura przyjęta w KSeF,
--    faktura odrzucona w KSeF, termin podatku z kalendarza modułu księgowości.
--    Link tylko do ścieżki w aplikacji (CHECK), nigdy do innej domeny.
--
-- 2. RLS: użytkownik czyta tylko swoje wpisy aktywnej firmy (x-active-org
--    i członkostwo, jak get_current_tenant_id() w 00037). Klucz użytkownika
--    nie dopisuje, nie zmienia i nie usuwa wpisów; datę przeczytania ustawia
--    tylko app_notifications_mark_read() (swoje wpisy aktywnej firmy, zawsze
--    „teraz”, bez powrotu na nieprzeczytane).
--
-- Wpisy znikają razem z firmą albo użytkownikiem (ON DELETE CASCADE).
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.app_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  -- Odbiorca (jak memberships.user_id).
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  -- Obiekt, którego dotyczy wpis (faktura, faktura i skrót powodu odrzucenia,
  -- rozliczenie i etap terminu); razem z rodzajem klucz idempotencji.
  object_key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ,
  CONSTRAINT app_notifications_klucz_unikalny UNIQUE (user_id, tenant_id, kind, object_key),
  CONSTRAINT app_notifications_kind_check CHECK (kind IN ('inbox_new', 'invoice_accepted', 'invoice_rejected', 'tax_deadline')),
  CONSTRAINT app_notifications_object_key_check CHECK (char_length(object_key) BETWEEN 1 AND 200),
  CONSTRAINT app_notifications_title_check CHECK (char_length(title) BETWEEN 1 AND 200),
  CONSTRAINT app_notifications_body_check CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 1000),
  -- Ścieżka w aplikacji: od „/” i litery, bez „//”, ukośnika wstecznego i białych znaków.
  CONSTRAINT app_notifications_link_check CHECK (
    link IS NULL OR (
      char_length(link) BETWEEN 2 AND 500
      AND link ~ '^/[a-z]'
      AND strpos(link, '//') = 0
      AND strpos(link, chr(92)) = 0
      AND link !~ '[[:space:][:cntrl:]]'
    )
  ),
  CONSTRAINT app_notifications_read_at_check CHECK (read_at IS NULL OR read_at >= created_at)
);

COMMENT ON TABLE public.app_notifications IS
  'Powiadomienia w aplikacji (dzwonek, krok 8.1 planu kompletnej aplikacji): wiersz na odbiorcę, UNIQUE jako klucz idempotencji jobów. Zapis tylko przez app_notification_publish (service_role).';

-- Lista w dzwonku: ostatnie wpisy odbiorcy w firmie.
CREATE INDEX IF NOT EXISTS app_notifications_lista_idx
  ON public.app_notifications (tenant_id, user_id, created_at DESC, id DESC);

-- Liczba nieprzeczytanych.
CREATE INDEX IF NOT EXISTS app_notifications_nieprzeczytane_idx
  ON public.app_notifications (tenant_id, user_id)
  WHERE read_at IS NULL;

ALTER TABLE public.app_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "app_notifications_select_own" ON public.app_notifications;
CREATE POLICY "app_notifications_select_own" ON public.app_notifications
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_current_tenant_id() AND user_id = auth.uid());

REVOKE ALL ON public.app_notifications FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.app_notifications TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_notifications TO service_role;

-- ─── Zapis przez zadanie: wpis dla każdego aktywnego członka firmy ───
-- SECURITY INVOKER: woła ją tylko service_role (EXECUTE niżej), który ma
-- uprawnienia do tabeli. Zwraca liczbę NOWYCH wpisów; ponowienie z tym samym
-- kluczem zwraca 0.
CREATE OR REPLACE FUNCTION public.app_notification_publish(
  p_tenant_id UUID,
  p_kind TEXT,
  p_object_key TEXT,
  p_title TEXT,
  p_body TEXT DEFAULT NULL,
  p_link TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_created INTEGER;
BEGIN
  INSERT INTO public.app_notifications (tenant_id, user_id, kind, object_key, title, body, link)
  SELECT p_tenant_id, m.user_id, p_kind, p_object_key, p_title, p_body, p_link
    FROM public.memberships AS m
   WHERE m.organization_id = p_tenant_id
     AND m.status = 'active'
  ON CONFLICT ON CONSTRAINT app_notifications_klucz_unikalny DO NOTHING;
  GET DIAGNOSTICS v_created = ROW_COUNT;
  RETURN v_created;
END;
$$;

COMMENT ON FUNCTION public.app_notification_publish(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) IS
  'Dzwonek (00188): wpis dla każdego aktywnego członka firmy; ON CONFLICT DO NOTHING na kluczu (odbiorca, firma, rodzaj, obiekt). Tylko service_role.';

REVOKE ALL ON FUNCTION public.app_notification_publish(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.app_notification_publish(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;

-- ─── Oznaczanie jako przeczytane: tylko własne wpisy aktywnej firmy ───
-- p_ids NULL = wszystkie nieprzeczytane; lista = tylko te (najwyżej 100).
-- Zwraca liczbę oznaczonych teraz wpisów.
CREATE OR REPLACE FUNCTION public.app_notifications_mark_read(p_ids UUID[] DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_tenant UUID;
  v_count INTEGER;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Marking notifications requires a session' USING ERRCODE = '42501';
  END IF;
  v_tenant := public.get_current_tenant_id();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  IF p_ids IS NOT NULL AND cardinality(p_ids) > 100 THEN
    RAISE EXCEPTION 'Too many notifications at once' USING ERRCODE = '22023';
  END IF;

  -- GREATEST: now() to początek transakcji; wpis zapisany tuż po nim nie łamie
  -- app_notifications_read_at_check.
  UPDATE public.app_notifications AS n
     SET read_at = GREATEST(now(), n.created_at)
   WHERE n.tenant_id = v_tenant
     AND n.user_id = v_user
     AND n.read_at IS NULL
     AND (p_ids IS NULL OR n.id = ANY (p_ids));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.app_notifications_mark_read(UUID[]) IS
  'Dzwonek (00188): oznacza własne wpisy aktywnej firmy jako przeczytane (NULL = wszystkie). Tylko authenticated.';

REVOKE ALL ON FUNCTION public.app_notifications_mark_read(UUID[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.app_notifications_mark_read(UUID[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
