-- ═══════════════════════════════════════════════════════════════
-- 00178: archiwum dokumentów firmy i paczka na kontrolę (plan
-- docs/koordynacja/PLAN-KOMPLETNA-APLIKACJA.md, krok 6.4, część 1)
--
-- KIEDY WGRAĆ: PRZED wdrożeniem. Nowa tabela, indeksy, funkcja wyzwalacza
-- i polityki RLS; bez DROP tabel i kolumn, bez zmiany istniejących danych.
-- Numery 00174-00177 zajmują inne PR z 9.11.2026; ta migracja od nich nie
-- zależy.
--
-- document_archives: zlecenie paczki ZIP z dokumentami firmy za okres
-- (rodzaj 'archive') albo paczki na kontrolę z JPK_FA (rodzaj 'audit').
-- Wiersz zakłada właściciel albo administrator; plik składa zadanie w tle
-- (kolejka archive.document.requested) i zapisuje go w magazynie pod kluczem
-- zlecenia exports/<firma>/archiwum/<zlecenie>/<plik>.zip (CHECK). Link do
-- pobrania działa 7 dni od gotowości (expires_at), podpisany na 5 minut.
--
-- Idempotencja: jedno aktywne zlecenie (pending, generating) na firmę i okres
-- (indeks częściowy UNIQUE). Ponowienie zadania od zera nie tworzy drugiego
-- pliku (zapis warunkowy IfNoneMatch pod stałym kluczem), gotowość zapisuje
-- się tylko ze stanu 'generating', a powiadomienie ma znacznik notified_at
-- i klucz idempotencji u dostawcy poczty.
--
-- Limit: jedno zlecenie na 10 minut na firmę (wyzwalacz przed INSERT
-- z blokadą doradczą na firmę, więc dwie karty nie przejdą razem). Ten sam
-- wyzwalacz zamyka jako 'failed' zlecenie aktywne dłużej niż 6 godzin
-- (próba zadania trwa najwyżej 4 godziny), żeby utknięte zlecenie nie
-- blokowało okresu na zawsze. Kto nie jest właścicielem ani administratorem
-- firmy ze zlecenia, dostaje odmowę uprawnień, zanim zobaczy limit.
--
-- RLS: odczyt, INSERT i usunięcie zlecenia 'pending' tylko owner/admin
-- (has_org_role z 00037); INSERT tylko kolumn treści (granty kolumnowe);
-- UPDATE tylko service_role (zadanie).
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.document_archives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  -- Pełne miesiące: pierwszy dzień pierwszego i ostatni dzień ostatniego.
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by UUID DEFAULT auth.uid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  file_key TEXT,
  file_name TEXT,
  size_bytes BIGINT,
  -- Pliki dokumentów w paczce (bez spisu i list CSV) i braki ze spisu.
  files_count INTEGER,
  missing_count INTEGER,
  error_message TEXT,
  notified_at TIMESTAMPTZ,
  CONSTRAINT document_archives_kind_check CHECK (kind IN ('archive', 'audit')),
  CONSTRAINT document_archives_status_check CHECK (status IN ('pending', 'generating', 'completed', 'failed')),
  CONSTRAINT document_archives_period_check CHECK (
    period_start >= DATE '2015-01-01'
    AND EXTRACT(DAY FROM period_start) = 1
    AND EXTRACT(DAY FROM (period_end + 1)) = 1
    AND period_end >= period_start
    AND period_end < (period_start + INTERVAL '12 months')::date
  ),
  CONSTRAINT document_archives_file_key_check CHECK (
    file_key IS NULL
    OR (file_key LIKE 'exports/' || tenant_id::text || '/archiwum/' || id::text || '/%' AND file_key NOT LIKE '%..%')
  ),
  CONSTRAINT document_archives_completed_check CHECK (
    status <> 'completed'
    OR (file_key IS NOT NULL AND file_name IS NOT NULL AND size_bytes IS NOT NULL AND files_count IS NOT NULL
        AND missing_count IS NOT NULL AND finished_at IS NOT NULL AND expires_at IS NOT NULL)
  ),
  CONSTRAINT document_archives_failed_check CHECK (status <> 'failed' OR error_message IS NOT NULL),
  CONSTRAINT document_archives_counts_check CHECK (
    (size_bytes IS NULL OR size_bytes >= 0) AND (files_count IS NULL OR files_count >= 0) AND (missing_count IS NULL OR missing_count >= 0)
  ),
  CONSTRAINT document_archives_text_check CHECK (
    (file_name IS NULL OR char_length(file_name) <= 200) AND (error_message IS NULL OR char_length(error_message) <= 1000)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS document_archives_one_active
  ON public.document_archives (tenant_id, period_start, period_end)
  WHERE status IN ('pending', 'generating');

CREATE INDEX IF NOT EXISTS document_archives_tenant_created
  ON public.document_archives (tenant_id, created_at DESC);

COMMENT ON TABLE public.document_archives IS
  'Zlecenia archiwum dokumentów firmy i paczki na kontrolę (plan kompletnej aplikacji, krok 6.4): '
  'stan, plik ZIP w magazynie pod kluczem zlecenia, wygaśnięcie linku i znacznik powiadomienia. '
  'Limit 10 minut i zamykanie utkniętych: wyzwalacz guard_document_archive_insert.';

CREATE OR REPLACE FUNCTION public.guard_document_archive_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  last_created TIMESTAMPTZ;
BEGIN
  -- Klucz użytkownika: najpierw uprawnienie, żeby obca firma nie poznała limitu.
  IF auth.uid() IS NOT NULL
     AND NOT (public.has_org_role(NEW.tenant_id, 'owner') OR public.has_org_role(NEW.tenant_id, 'admin')) THEN
    RAISE EXCEPTION 'Archiwum może zlecić właściciel albo administrator firmy.'
      USING ERRCODE = '42501', HINT = 'document_archive_forbidden';
  END IF;

  -- Zlecenia jednej firmy po kolei: dwie karty nie przejdą limitu razem.
  PERFORM pg_advisory_xact_lock(hashtextextended('document_archives:' || NEW.tenant_id::text, 0));

  UPDATE public.document_archives
     SET status = 'failed',
         finished_at = now(),
         error_message = 'Przygotowanie paczki przerwało się. Zleć ją ponownie.'
   WHERE tenant_id = NEW.tenant_id
     AND status IN ('pending', 'generating')
     AND created_at < now() - INTERVAL '6 hours';

  SELECT max(created_at) INTO last_created
    FROM public.document_archives
   WHERE tenant_id = NEW.tenant_id;

  IF last_created IS NOT NULL AND last_created > now() - INTERVAL '10 minutes' THEN
    RAISE EXCEPTION 'Kolejną paczkę można zlecić po %.',
      to_char((last_created + INTERVAL '10 minutes') AT TIME ZONE 'Europe/Warsaw', 'HH24:MI')
      USING ERRCODE = 'P0001', HINT = 'document_archive_rate_limit';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_document_archive_insert() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trigger_document_archives_guard_insert ON public.document_archives;
CREATE TRIGGER trigger_document_archives_guard_insert
  BEFORE INSERT ON public.document_archives
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_document_archive_insert();

ALTER TABLE public.document_archives ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "document_archives_select_owner_admin" ON public.document_archives;
CREATE POLICY "document_archives_select_owner_admin"
  ON public.document_archives
  FOR SELECT
  TO authenticated
  USING (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
  );

DROP POLICY IF EXISTS "document_archives_insert_owner_admin" ON public.document_archives;
CREATE POLICY "document_archives_insert_owner_admin"
  ON public.document_archives
  FOR INSERT
  TO authenticated
  WITH CHECK (
    tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
  );

-- Tylko zlecenie, którego zadanie nie wyszło z akcji (stan 'pending').
DROP POLICY IF EXISTS "document_archives_delete_pending_owner_admin" ON public.document_archives;
CREATE POLICY "document_archives_delete_pending_owner_admin"
  ON public.document_archives
  FOR DELETE
  TO authenticated
  USING (
    status = 'pending'
    AND tenant_id = public.get_current_tenant_id()
    AND (public.has_org_role(tenant_id, 'owner') OR public.has_org_role(tenant_id, 'admin'))
  );

REVOKE ALL ON public.document_archives FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.document_archives TO authenticated;
GRANT INSERT (tenant_id, kind, period_start, period_end) ON public.document_archives TO authenticated;
GRANT DELETE ON public.document_archives TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_archives TO service_role;

NOTIFY pgrst, 'reload schema';
