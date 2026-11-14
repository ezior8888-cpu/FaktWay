-- ═══════════════════════════════════════════════════════════════
-- 00202: klucz idempotencji wgrania zdjęcia kosztu z telefonu (plan aplikacji
-- mobilnej, docs/koordynacja/PLAN-APLIKACJA-MOBILNA.md, etap M9).
--
-- KIEDY WGRAĆ: PRZED wdrożeniem kodu M9, PO 00201 (rozszerza jej tabelę).
-- Addytywna: nowa kolumna NULL, poluzowanie NOT NULL `invoice_id`, CHECK
-- zastąpiony szerszym (każdy istniejący wiersz z 00201 go spełnia), nowy
-- klucz obcy, indeks unikalny `ocr_jobs (tenant_id, id)` i uprawnienie do
-- kolumny. Bez DROP tabel i kolumn, bez TRUNCATE, bez zmian danych.
-- Stara wersja aplikacji (M8) dalej wstawia wiersze faktur jak dotąd.
--
-- Po co: `POST /api/mobile/v1/wydatki/zdjecie` przyjmuje zdjęcie paragonu albo
-- faktury i zleca odczyt (OCR); worker zapisuje z odczytu wydatek, który od
-- razu liczy się do KPiR (`lib/jobs/runners/process-ocr.ts`). Telefon traci
-- odpowiedź (zerwane połączenie, limit czasu) i ponawia to samo wgranie z tym
-- samym nagłówkiem `Idempotency-Key`. Ponowienie nie może zlecić drugiego
-- odczytu, bo drugi odczyt to drugi koszt w KPiR i drugie odliczenie VAT
-- (AGENTS.md, protokół naprawy, punkt 5). Trasa zapisuje klucz zaraz po
-- zadaniu OCR, zanim wgra plik i zleci odczyt, więc ponowienie oddaje
-- zadanie pierwszego wgrania.
--
-- 1. `mobile_idempotency_keys.ocr_job_id`: zadanie OCR wgrania, kluczem
--    złożonym z firmą do `ocr_jobs (tenant_id, id)` z ON DELETE CASCADE.
--    Wgranie, które padło po zapisie klucza (błąd magazynu albo kolejki),
--    usuwa swoje zadanie, a z nim klucz: ponowienie wgrywa od nowa.
--    `ocr_jobs` nie miało UNIQUE (tenant_id, id) (00146 pominęła klucz obcy
--    z tego powodu), więc dochodzi indeks unikalny: `id` to klucz główny, więc
--    indeks niczego nie odrzuci, tylko pozwala na klucz złożony.
-- 2. `invoice_id` może być NULL; CHECK `mobile_idempotency_keys_endpoint_check`
--    wiąże trasę z celem: faktura dla `POST /api/mobile/v1/faktury`, zadanie
--    OCR dla `POST /api/mobile/v1/wydatki/zdjecie`, nigdy oba naraz.
-- 3. RLS i uprawnienia jak w 00201 (polityki bez zmian); klient dopisuje też
--    kolumnę `ocr_job_id`.
--
-- BLOKADA: budowa indeksu bierze SHARE na `ocr_jobs` (odczyty działają,
-- nowe zadania OCR czekają kilka milisekund: tabela ma po jednym wierszu na
-- zdjęcie). lock_timeout 5 s: przy zajętej tabeli migracja pada (55P03) zamiast
-- ustawiać kolejkę; powtórzyć później. Bez CONCURRENTLY (nie działa w transakcji).
-- Ostrzeżenie psql o transakcji przy --single-transaction jest oczekiwane, jak przy 00146.
--
-- PO: schema_migrations ('00202', 'mobile_idempotency_expense_upload'),
-- NOTIFY pgrst, weryfikacja:
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'public.mobile_idempotency_keys'::regclass;
--
-- Wycofanie (za zgodą Bartosza; najpierw usunąć wiersze wgrań):
--   DELETE FROM public.mobile_idempotency_keys WHERE ocr_job_id IS NOT NULL;
--   ALTER TABLE public.mobile_idempotency_keys DROP CONSTRAINT mobile_idempotency_keys_ocr_job_fk;
--   ALTER TABLE public.mobile_idempotency_keys DROP CONSTRAINT mobile_idempotency_keys_endpoint_check;
--   ALTER TABLE public.mobile_idempotency_keys ADD CONSTRAINT mobile_idempotency_keys_endpoint_check
--     CHECK (endpoint = 'POST /api/mobile/v1/faktury');
--   ALTER TABLE public.mobile_idempotency_keys ALTER COLUMN invoice_id SET NOT NULL;
--   ALTER TABLE public.mobile_idempotency_keys DROP COLUMN ocr_job_id;
--   DROP INDEX public.uq_ocr_jobs_tenant_id;
-- ═══════════════════════════════════════════════════════════════

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX IF NOT EXISTS uq_ocr_jobs_tenant_id
  ON public.ocr_jobs (tenant_id, id);

COMMENT ON INDEX public.uq_ocr_jobs_tenant_id IS
  'Klucz złożony (tenant_id, id) dla mobile_idempotency_keys.ocr_job_id (00202): klucz zapisu telefonu nie wskaże zadania OCR innej firmy.';

ALTER TABLE public.mobile_idempotency_keys
  ADD COLUMN IF NOT EXISTS ocr_job_id UUID;

ALTER TABLE public.mobile_idempotency_keys
  ALTER COLUMN invoice_id DROP NOT NULL;

ALTER TABLE public.mobile_idempotency_keys
  DROP CONSTRAINT IF EXISTS mobile_idempotency_keys_endpoint_check;
ALTER TABLE public.mobile_idempotency_keys
  ADD CONSTRAINT mobile_idempotency_keys_endpoint_check CHECK (
    (endpoint = 'POST /api/mobile/v1/faktury' AND invoice_id IS NOT NULL AND ocr_job_id IS NULL)
    OR (endpoint = 'POST /api/mobile/v1/wydatki/zdjecie' AND ocr_job_id IS NOT NULL AND invoice_id IS NULL)
  );

ALTER TABLE public.mobile_idempotency_keys
  DROP CONSTRAINT IF EXISTS mobile_idempotency_keys_ocr_job_fk;
ALTER TABLE public.mobile_idempotency_keys
  ADD CONSTRAINT mobile_idempotency_keys_ocr_job_fk
    FOREIGN KEY (tenant_id, ocr_job_id) REFERENCES public.ocr_jobs (tenant_id, id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_mobile_idempotency_keys_ocr_job
  ON public.mobile_idempotency_keys (tenant_id, ocr_job_id)
  WHERE ocr_job_id IS NOT NULL;

COMMENT ON COLUMN public.mobile_idempotency_keys.ocr_job_id IS
  'Zadanie OCR wgrania zdjęcia kosztu z telefonu (00202, M9): ponowione POST /api/mobile/v1/wydatki/zdjecie oddaje to zadanie zamiast zlecać drugi odczyt i drugi koszt.';

COMMENT ON TABLE public.mobile_idempotency_keys IS
  'Klucze idempotencji zapisów z aplikacji na telefon (00201 faktury, 00202 zdjęcia kosztów): '
  'UNIQUE (tenant_id, user_id, idempotency_key), skrót treści żądania i cel: faktura albo zadanie OCR. '
  'Ponowione żądanie z tym samym kluczem oddaje zapisany cel zamiast tworzyć drugi.';

GRANT INSERT (ocr_job_id) ON public.mobile_idempotency_keys TO authenticated;

COMMIT;
