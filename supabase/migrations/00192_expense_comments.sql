-- ═══════════════════════════════════════════════════════════════
-- 00192: komentarze i prośby o dokument przy koszcie, z wpisem w dzwonku
-- (plan docs/koordynacja/PLAN-KOMPLETNA-APLIKACJA.md, krok 6.2, część 3)
--
-- KIEDY WGRAĆ: PRZED wdrożeniem, po 00188 (funkcja dopisuje wpisy do
-- app_notifications i rozszerza listę jej rodzajów). Nowa tabela, dwie
-- funkcje i zmiana jednego CHECK-a; bez DROP tabel i kolumn, bez zmiany
-- istniejących danych. Bez tej migracji wątek na ekranie kosztu pokazuje „Nie
-- udało się wczytać komentarzy do kosztu” ze „Spróbuj ponownie”, a reszta
-- ekranu kosztu działa bez zmian.
--
-- ZMIANA CHECK: app_notifications_kind_check z 00188 dostaje dwa rodzaje:
-- expense_comment (nowy komentarz przy koszcie) i expense_document_request
-- (nowa prośba o dokument). DROP CONSTRAINT IF EXISTS i ADD CONSTRAINT z tą
-- samą nazwą i pełną listą: cztery rodzaje z 00188 bez zmian plus dwa nowe.
-- Istniejące wiersze mają rodzaje z 00188, więc spełniają nowy warunek
-- (sprawdzenie przy ADD CONSTRAINT niczego nie odrzuci; krótka blokada
-- app_notifications na czas przejścia po wierszach). Kto dopisze kolejny rodzaj,
-- bierze pełną listę z tej migracji (pilnuje tego test koszt-watek-migracja).
--
-- 1. expense_comments: wątek przy koszcie. Wiersz to komentarz albo prośba
--    o dokument (np. księgowa prosi o fakturę zamiast paragonu). Prośba ma stan:
--    otwarta (resolved_at IS NULL) albo załatwiona (resolved_at i resolved_by:
--    kto i kiedy). Treść 1-2000 znaków, nie same białe znaki. Autor i jego rola
--    z sesji (auth.uid() i memberships), nigdy z argumentów. Wątek znika razem
--    z kosztem albo firmą (ON DELETE CASCADE). Po usunięciu konta autor i osoba,
--    która załatwiła prośbę, zostają pustym polem (SET NULL), a wpis pokazuje
--    rolę autora z chwili wpisu.
--
-- 2. Kto: członkowie firmy z rolą owner, admin, member, accountant, czyli ci
--    sami, którzy widzą koszty (expenses_select_own_tenant z 00034: aktywny
--    członek aktywnej firmy, bez podziału na role). Odczyt przez RLS: aktywna
--    firma (x-active-org i członkostwo) i koszt widoczny dla czytającego
--    (podzapytanie pod RLS kosztów), więc kto nie widzi kosztu, nie widzi jego
--    wątku. Zapis tylko przez dwie funkcje SECURITY DEFINER: klucz użytkownika
--    nie ma INSERT, UPDATE ani DELETE na tabeli. Funkcje sprawdzają koszt tym
--    samym warunkiem co expenses_select_own_tenant; przy zmianie polityki
--    kosztów zmienia się też tu.
--
-- 3. expense_comment_add(): komentarz albo prośba i w tej samej transakcji
--    wpis w dzwonku dla pozostałych aktywnych członków firmy (bez autora)
--    z linkiem do wątku kosztu. Klucz idempotencji to identyfikator komentarza
--    (nadaje go przeglądarka przy wysyłce i powtarza przy ponowieniu tej samej
--    treści): ponowienie z tym samym identyfikatorem i treścią zwraca exists
--    i nic nie dopisuje, a wpisy w dzwonku mają UNIQUE z 00188 i ON CONFLICT
--    DO NOTHING. Ten sam identyfikator z inną treścią, rodzajem, kosztem albo
--    autorem to odmowa conflict. Tytuł, treść i link wpisu w dzwonku buduje baza
--    z danych kosztu i autora, nie z argumentów. Prośba o dokument dostaje wiersz
--    audit_logs (expense.document_requested).
--
-- 4. expense_document_request_resolve(): oznacza prośbę jako załatwioną (kto
--    i kiedy, zawsze „teraz”) z wierszem audit_logs
--    (expense.document_request_resolved). Powtórka zwraca already_resolved
--    i nic nie zmienia. Komentarza nie da się „załatwić”, a załatwionej prośby
--    nie otwiera się ponownie: nowa potrzeba to nowa prośba.
--
-- audit_logs: ip_address i user_agent zostają puste jak w 00158 (baza nie zna
-- adresu klienta). W metadanych identyfikator wpisu i rola, bez treści.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.app_notifications
  DROP CONSTRAINT IF EXISTS app_notifications_kind_check,
  ADD CONSTRAINT app_notifications_kind_check CHECK (kind IN ('inbox_new', 'invoice_accepted', 'invoice_rejected', 'tax_deadline', 'expense_comment', 'expense_document_request'));

CREATE TABLE IF NOT EXISTS public.expense_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  expense_id UUID NOT NULL REFERENCES public.expenses(id) ON DELETE CASCADE,
  author_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  -- Rola autora w firmie w chwili wpisu (jak memberships.role).
  author_role TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Tylko prośba o dokument: kiedy i kto ją załatwił.
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT expense_comments_kind_check CHECK (kind IN ('comment', 'document_request')),
  CONSTRAINT expense_comments_author_role_check CHECK (author_role IN ('owner', 'admin', 'member', 'accountant')),
  CONSTRAINT expense_comments_body_check CHECK (char_length(body) BETWEEN 1 AND 2000 AND body ~ '[^[:space:]]'),
  -- Otwarta: bez daty i osoby. Załatwiona: tylko prośba, data nie przed wpisem
  -- (osoba może zniknąć po usunięciu konta, data zostaje).
  CONSTRAINT expense_comments_resolved_check CHECK (
    (resolved_at IS NULL AND resolved_by IS NULL)
    OR (kind = 'document_request' AND resolved_at IS NOT NULL AND resolved_at >= created_at)
  )
);

COMMENT ON TABLE public.expense_comments IS
  'Wątek przy koszcie (krok 6.2 planu kompletnej aplikacji): komentarze i prośby o dokument ze stanem otwarta albo załatwiona. Zapis tylko przez expense_comment_add i expense_document_request_resolve (00192).';

-- Wątek kosztu od najnowszego; służy też kasowaniu wątku razem z kosztem.
CREATE INDEX IF NOT EXISTS expense_comments_watek_idx
  ON public.expense_comments (expense_id, created_at DESC, id DESC);

ALTER TABLE public.expense_comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "expense_comments_select_cost_readers" ON public.expense_comments;
CREATE POLICY "expense_comments_select_cost_readers" ON public.expense_comments
  FOR SELECT TO authenticated
  USING (
    tenant_id = public.get_current_tenant_id()
    AND EXISTS (
      SELECT 1
        FROM public.expenses AS e
       WHERE e.id = expense_comments.expense_id
         AND e.tenant_id = expense_comments.tenant_id
    )
  );

REVOKE ALL ON public.expense_comments FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.expense_comments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.expense_comments TO service_role;

-- ─── Nowy wpis w wątku i wpis w dzwonku pozostałych członków ───
-- Zwraca status: created, exists (ponowienie) albo refused z kodem
-- (invalid_kind, empty_body, body_too_long, not_found, conflict).
CREATE OR REPLACE FUNCTION public.expense_comment_add(
  p_expense_id UUID,
  p_kind TEXT,
  p_body TEXT,
  p_comment_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_tenant UUID;
  v_role TEXT;
  v_id UUID := COALESCE(p_comment_id, gen_random_uuid());
  v_body TEXT;
  v_document TEXT;
  v_seller TEXT;
  v_created_at TIMESTAMPTZ;
  v_existing public.expense_comments%ROWTYPE;
  v_name TEXT;
  v_author TEXT;
  v_label TEXT;
  v_excerpt TEXT;
  v_notified INTEGER := 0;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Expense comments require a session' USING ERRCODE = '42501';
  END IF;
  v_tenant := public.get_current_tenant_id();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  SELECT m.role INTO v_role
    FROM public.memberships AS m
   WHERE m.organization_id = v_tenant
     AND m.user_id = v_user
     AND m.status = 'active'
     AND m.role IN ('owner', 'admin', 'member', 'accountant');
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Insufficient role for expense comments' USING ERRCODE = '42501';
  END IF;

  IF p_kind IS NULL OR p_kind NOT IN ('comment', 'document_request') THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'invalid_kind');
  END IF;
  -- Białe znaki z obu końców (spacje, tabulatory, nowe linie); w środku zostają.
  v_body := regexp_replace(COALESCE(p_body, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g');
  IF v_body = '' THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'empty_body');
  END IF;
  IF char_length(v_body) > 2000 THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'body_too_long');
  END IF;

  -- Koszt aktywnej firmy: ten sam warunek co expenses_select_own_tenant (00034).
  -- Koszt innej firmy wygląda jak brak kosztu.
  SELECT e.document_number, e.seller_name INTO v_document, v_seller
    FROM public.expenses AS e
   WHERE e.id = p_expense_id
     AND e.tenant_id = v_tenant;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_found');
  END IF;

  INSERT INTO public.expense_comments (id, tenant_id, expense_id, author_id, author_role, kind, body)
  VALUES (v_id, v_tenant, p_expense_id, v_user, v_role, p_kind, v_body)
  ON CONFLICT (id) DO NOTHING
  RETURNING created_at INTO v_created_at;

  IF v_created_at IS NULL THEN
    -- Ponowienie: wpis z tym identyfikatorem już jest. Ten sam autor, koszt,
    -- rodzaj i treść to ten sam wpis (dzwonek i audyt zapisała pierwsza
    -- transakcja); cokolwiek innego to odmowa bez zmiany wpisu.
    SELECT * INTO v_existing FROM public.expense_comments AS c WHERE c.id = v_id;
    IF v_existing.tenant_id = v_tenant
       AND v_existing.expense_id = p_expense_id
       AND v_existing.author_id = v_user
       AND v_existing.kind = p_kind
       AND v_existing.body = v_body
    THEN
      RETURN jsonb_build_object('status', 'exists', 'comment_id', v_id, 'expense_id', p_expense_id, 'kind', p_kind, 'notified', 0);
    END IF;
    RETURN jsonb_build_object('status', 'refused', 'code', 'conflict');
  END IF;

  -- Treść wpisu w dzwonku: kto, przy którym koszcie i początek wpisu.
  SELECT NULLIF(btrim(u.name), '') INTO v_name FROM public.users AS u WHERE u.id = v_user;
  v_author := CASE
    WHEN v_name IS NOT NULL THEN left(v_name, 80) || ' (' || CASE v_role
      WHEN 'owner' THEN 'właściciel'
      WHEN 'admin' THEN 'admin'
      WHEN 'member' THEN 'członek'
      ELSE 'księgowy'
    END || ')'
    ELSE CASE v_role
      WHEN 'owner' THEN 'Właściciel'
      WHEN 'admin' THEN 'Admin'
      WHEN 'member' THEN 'Członek'
      ELSE 'Księgowy'
    END
  END;
  -- Sprzedawca bez nazwy w metadanych KSeF ma w koszcie „Nieznany” (auto-categorize-inbox).
  v_label := COALESCE(left(NULLIF(btrim(v_document), ''), 60), 'bez numeru')
    || CASE
         WHEN NULLIF(btrim(v_seller), '') IS NULL OR btrim(v_seller) = 'Nieznany' THEN ''
         ELSE ' od ' || left(btrim(v_seller), 120)
       END;
  v_excerpt := regexp_replace(v_body, '[[:space:]]+', ' ', 'g');
  IF char_length(v_excerpt) > 140 THEN
    v_excerpt := left(v_excerpt, 139) || '…';
  END IF;

  INSERT INTO public.app_notifications (tenant_id, user_id, kind, object_key, title, body, link)
  SELECT v_tenant,
         m.user_id,
         CASE p_kind WHEN 'comment' THEN 'expense_comment' ELSE 'expense_document_request' END,
         v_id::text,
         CASE p_kind WHEN 'comment' THEN 'Nowy komentarz do kosztu' ELSE 'Prośba o dokument do kosztu' END,
         v_author || ' przy koszcie ' || v_label || ': ' || v_excerpt,
         '/expenses/' || p_expense_id::text || '#komentarze'
    FROM public.memberships AS m
   WHERE m.organization_id = v_tenant
     AND m.status = 'active'
     AND m.role IN ('owner', 'admin', 'member', 'accountant')
     AND m.user_id <> v_user
  ON CONFLICT ON CONSTRAINT app_notifications_klucz_unikalny DO NOTHING;
  GET DIAGNOSTICS v_notified = ROW_COUNT;

  IF p_kind = 'document_request' THEN
    INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
    VALUES (
      v_tenant, v_user, 'expense.document_requested', 'expense', p_expense_id,
      jsonb_build_object('commentId', v_id, 'role', v_role, 'notified', v_notified)
    );
  END IF;

  RETURN jsonb_build_object('status', 'created', 'comment_id', v_id, 'expense_id', p_expense_id, 'kind', p_kind, 'notified', v_notified);
END;
$$;

COMMENT ON FUNCTION public.expense_comment_add(UUID, TEXT, TEXT, UUID) IS
  'Wątek przy koszcie (00192): komentarz albo prośba o dokument i wpis w dzwonku pozostałych aktywnych członków firmy w jednej transakcji; klucz idempotencji to identyfikator komentarza. Tylko authenticated.';

REVOKE ALL ON FUNCTION public.expense_comment_add(UUID, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.expense_comment_add(UUID, TEXT, TEXT, UUID) TO authenticated;

-- ─── Prośba o dokument załatwiona: kto i kiedy ───
-- Zwraca status: resolved, already_resolved albo refused z kodem
-- (not_found, not_request).
CREATE OR REPLACE FUNCTION public.expense_document_request_resolve(p_comment_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_tenant UUID;
  v_role TEXT;
  v_comment public.expense_comments%ROWTYPE;
  v_resolved_at TIMESTAMPTZ;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Expense comments require a session' USING ERRCODE = '42501';
  END IF;
  v_tenant := public.get_current_tenant_id();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'No active organization' USING ERRCODE = '42501';
  END IF;
  SELECT m.role INTO v_role
    FROM public.memberships AS m
   WHERE m.organization_id = v_tenant
     AND m.user_id = v_user
     AND m.status = 'active'
     AND m.role IN ('owner', 'admin', 'member', 'accountant');
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Insufficient role for expense comments' USING ERRCODE = '42501';
  END IF;

  -- Blokada wiersza: dwie osoby naraz idą po kolei, druga widzi już załatwioną.
  -- Prośba innej firmy albo przy koszcie innej firmy wygląda jak brak prośby.
  SELECT c.* INTO v_comment
    FROM public.expense_comments AS c
    JOIN public.expenses AS e ON e.id = c.expense_id AND e.tenant_id = c.tenant_id
   WHERE c.id = p_comment_id
     AND c.tenant_id = v_tenant
   FOR UPDATE OF c;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_found');
  END IF;
  IF v_comment.kind <> 'document_request' THEN
    RETURN jsonb_build_object('status', 'refused', 'code', 'not_request', 'expense_id', v_comment.expense_id);
  END IF;
  IF v_comment.resolved_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'already_resolved',
      'expense_id', v_comment.expense_id,
      'resolved_at', v_comment.resolved_at,
      'resolved_by', v_comment.resolved_by
    );
  END IF;

  -- GREATEST: now() to początek transakcji; wpis zapisany tuż po nim nie łamie
  -- expense_comments_resolved_check.
  v_resolved_at := GREATEST(now(), v_comment.created_at);
  UPDATE public.expense_comments AS c
     SET resolved_at = v_resolved_at,
         resolved_by = v_user
   WHERE c.id = p_comment_id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_tenant, v_user, 'expense.document_request_resolved', 'expense', v_comment.expense_id,
    jsonb_build_object('commentId', p_comment_id, 'role', v_role, 'requestedAt', v_comment.created_at)
  );

  RETURN jsonb_build_object(
    'status', 'resolved',
    'expense_id', v_comment.expense_id,
    'resolved_at', v_resolved_at,
    'resolved_by', v_user
  );
END;
$$;

COMMENT ON FUNCTION public.expense_document_request_resolve(UUID) IS
  'Wątek przy koszcie (00192): prośba o dokument załatwiona (kto i kiedy) z wpisem audit_logs; powtórka zwraca already_resolved. Tylko authenticated.';

REVOKE ALL ON FUNCTION public.expense_document_request_resolve(UUID) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.expense_document_request_resolve(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
