-- ═══════════════════════════════════════════════════════════════
-- 00190: usuwanie z magazynu plików wygasłych paczek archiwum (plan
-- docs/koordynacja/PLAN-KOMPLETNA-APLIKACJA.md, krok 6.4, część 2)
--
-- KIEDY WGRAĆ: PRZED wdrożeniem, po 00178 (document_archives). Addytywna:
-- nowa kolumna, nowy CHECK, indeks częściowy i funkcja; bez DROP tabel
-- i kolumn, bez zmiany istniejących danych. Numery 00179-00189 zajmują inne
-- otwarte PR (#552, #549, #573, #568, #575, #583, #582, #579, #595, #600,
-- #590); ta migracja od nich nie zależy.
--
-- Zadanie cron.document-archive-cleanup
-- (lib/jobs/runners/document-archive-cleanup.ts) raz na dobę usuwa z magazynu
-- plik paczki 'completed', której link wygasł (expires_at) ponad godzinę
-- temu. Usuwa WYŁĄCZNIE obiekt o kluczu file_key z wiersza, w katalogu tego
-- zlecenia (exports/<firma>/archiwum/<zlecenie>/<plik>), bez usuwania po
-- prefiksie i bez listowania. Wiersz zostaje jako historia.
--
-- file_deleted_at: kiedy plik paczki usunięto z magazynu. Ustawia go tylko
-- funkcja mark_document_archive_file_deleted (EXECUTE tylko service_role), PO
-- udanym usunięciu obiektu, w jednej transakcji z wpisem audit_logs
-- (document_archive.file_deleted), więc nie ma znacznika bez śladu ani śladu
-- bez znacznika. Funkcja zmienia tylko wiersz 'completed' z wygasłym linkiem,
-- z tym samym kluczem pliku i bez znacznika; drugie wywołanie zwraca false
-- (ponowienie zadania od zera nie dopisze drugiego wpisu).
--
-- CHECK (zmiana): dochodzi document_archives_file_deleted_check. Znacznik
-- tylko przy paczce 'completed' z kluczem pliku i nie wcześniej niż
-- wygaśnięcie linku, więc także kluczem serwisowym nie oznaczy się paczki
-- w przygotowaniu ani ważnej, a linku usuniętej paczki nie da się przedłużyć.
-- Istniejące CHECK-i z 00178 bez zmian. Dotychczasowe wiersze mają
-- file_deleted_at = NULL, więc spełniają nowy warunek. DROP CONSTRAINT IF
-- EXISTS dotyczy tylko tego nowego CHECK (żeby migrację dało się powtórzyć).
--
-- Paczki 'failed' nie mają klucza pliku (00178 zapisuje file_key dopiero
-- razem z 'completed'), więc zadanie i funkcja ich nie dotykają.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.document_archives
  ADD COLUMN IF NOT EXISTS file_deleted_at TIMESTAMPTZ;

ALTER TABLE public.document_archives
  DROP CONSTRAINT IF EXISTS document_archives_file_deleted_check;
ALTER TABLE public.document_archives
  ADD CONSTRAINT document_archives_file_deleted_check CHECK (
    file_deleted_at IS NULL
    OR (status = 'completed' AND file_key IS NOT NULL AND expires_at IS NOT NULL AND file_deleted_at >= expires_at)
  );

COMMENT ON COLUMN public.document_archives.file_deleted_at IS
  'Kiedy plik paczki usunięto z magazynu po wygaśnięciu linku (zadanie cron.document-archive-cleanup, 00190). '
  'Wiersz zostaje jako historia; znacznik ustawia tylko mark_document_archive_file_deleted.';

-- Kandydaci zadania: gotowe paczki, których pliku jeszcze nie usunięto.
CREATE INDEX IF NOT EXISTS document_archives_file_cleanup
  ON public.document_archives (expires_at)
  WHERE status = 'completed' AND file_deleted_at IS NULL;

CREATE OR REPLACE FUNCTION public.mark_document_archive_file_deleted(p_archive_id uuid, p_file_key text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.document_archives%ROWTYPE;
BEGIN
  -- Warunek jak w zadaniu: gotowa paczka, ten sam klucz, link wygasł, bez znacznika.
  UPDATE public.document_archives
     SET file_deleted_at = now()
   WHERE id = p_archive_id
     AND status = 'completed'
     AND file_key = p_file_key
     AND file_deleted_at IS NULL
     AND expires_at < now()
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- W tej samej transakcji co znacznik: bez znacznika bez śladu i odwrotnie.
  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_row.tenant_id, NULL, 'document_archive.file_deleted', 'document_archive', v_row.id,
    jsonb_build_object(
      'kind', v_row.kind,
      'periodStart', v_row.period_start,
      'periodEnd', v_row.period_end,
      'fileName', v_row.file_name,
      'sizeBytes', v_row.size_bytes,
      'expiresAt', v_row.expires_at,
      'source', 'system'
    )
  );

  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.mark_document_archive_file_deleted(uuid, text) IS
  'Znacznik usunięcia pliku wygasłej paczki archiwum (00190): UPDATE z warunkiem (completed, ten sam klucz, '
  'link wygasł, bez znacznika) i wpis audit_logs document_archive.file_deleted w jednej transakcji. '
  'Zwraca false, gdy wiersz nie spełnia warunku albo ma już znacznik. Tylko service_role (zadanie).';

REVOKE ALL ON FUNCTION public.mark_document_archive_file_deleted(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_document_archive_file_deleted(uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';
