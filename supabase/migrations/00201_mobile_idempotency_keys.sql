-- ═══════════════════════════════════════════════════════════════
-- 00201: klucze idempotencji zapisów z aplikacji na telefon (plan aplikacji
-- mobilnej, docs/koordynacja/PLAN-APLIKACJA-MOBILNA.md, etap M8).
--
-- KIEDY WGRAĆ: PRZED wdrożeniem kodu. Addytywna: jedna nowa tabela z RLS,
-- indeksy i uprawnienia na niej. Stara wersja aplikacji tabeli nie zna.
-- Bez DROP tabel i kolumn, bez TRUNCATE, bez zmian istniejących danych.
--
-- Po co: `POST /api/mobile/v1/faktury` wystawia fakturę (szkic albo szkic
-- i kolejka KSeF). Telefon traci odpowiedź (zerwane połączenie, limit 15 s)
-- i ponawia to samo żądanie z tym samym nagłówkiem `Idempotency-Key`.
-- Ponowienie nie może utworzyć drugiej faktury ani zlecić drugiej wysyłki
-- (AGENTS.md, protokół naprawy, punkt 5): trasa najpierw szuka klucza i oddaje
-- zapisaną fakturę. Ten sam wzór co `api_idempotency_keys` publicznego API
-- (00184), ale dla konta z telefonu zamiast klucza API.
--
-- Kolejność w trasie (lib/api/mobile/faktury.ts): szkic faktury, potem wiersz
-- klucza, potem kolejka KSeF. Przerwa między szkicem a kluczem zostawia szkic
-- bez klucza; ponowienie z tym samym numerem faktury odbija wtedy unikalny
-- numer w firmie (00028), więc drugiej faktury i tak nie ma. Ponowienie po
-- kluczu, a przed kolejką, zleca wysyłkę szkicu tą samą drogą co „Wyślij”
-- (RPC `enqueue_ksef_send` przejmuje tylko szkic).
--
-- 1. `mobile_idempotency_keys`: firma, konto, klucz (UUID z telefonu, jeden
--    na wypełnienie formularza), skrót SHA-256 treści żądania (ta sama treść
--    z tym samym kluczem to ponowienie, inna to 409), trasa, faktura.
--    UNIQUE (firma, konto, klucz). Faktura przez klucz złożony z firmą
--    (indeks `invoices (tenant_id, id)` z 00073), więc klucz nie wskaże
--    faktury innej firmy; usunięcie szkicu usuwa klucz (ON DELETE CASCADE).
-- 2. RLS: konto czyta i dopisuje tylko własne klucze w aktywnej firmie
--    (`get_current_tenant_id()` z nagłówka `x-active-org` i członkostwa,
--    00037). Bez UPDATE i DELETE dla klienta; serwis do kopii i sprzątania.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.mobile_idempotency_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  idempotency_key UUID NOT NULL,
  -- SHA-256 (hex) treści żądania w postaci kanonicznej (lib/api/mobile/faktury.ts).
  request_hash TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  invoice_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mobile_idempotency_keys_hash_check CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT mobile_idempotency_keys_endpoint_check CHECK (endpoint = 'POST /api/mobile/v1/faktury'),
  CONSTRAINT mobile_idempotency_keys_invoice_fk
    FOREIGN KEY (tenant_id, invoice_id) REFERENCES public.invoices (tenant_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mobile_idempotency_keys_key
  ON public.mobile_idempotency_keys (tenant_id, user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_mobile_idempotency_keys_invoice
  ON public.mobile_idempotency_keys (tenant_id, invoice_id);
CREATE INDEX IF NOT EXISTS idx_mobile_idempotency_keys_user
  ON public.mobile_idempotency_keys (user_id);

COMMENT ON TABLE public.mobile_idempotency_keys IS
  'Klucze idempotencji zapisów z aplikacji na telefon (00201, plan aplikacji mobilnej M8): '
  'UNIQUE (tenant_id, user_id, idempotency_key), skrót treści żądania i utworzona faktura. '
  'Ponowione POST /api/mobile/v1/faktury z tym samym kluczem oddaje tę fakturę zamiast wystawiać drugą.';

ALTER TABLE public.mobile_idempotency_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "mobile_idempotency_keys_select_own" ON public.mobile_idempotency_keys;
CREATE POLICY "mobile_idempotency_keys_select_own" ON public.mobile_idempotency_keys
  FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    AND tenant_id = (SELECT public.get_current_tenant_id())
  );

DROP POLICY IF EXISTS "mobile_idempotency_keys_insert_own" ON public.mobile_idempotency_keys;
CREATE POLICY "mobile_idempotency_keys_insert_own" ON public.mobile_idempotency_keys
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND tenant_id = (SELECT public.get_current_tenant_id())
  );

REVOKE ALL ON public.mobile_idempotency_keys FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.mobile_idempotency_keys TO authenticated;
GRANT INSERT (tenant_id, user_id, idempotency_key, request_hash, endpoint, invoice_id)
  ON public.mobile_idempotency_keys TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.mobile_idempotency_keys TO service_role;
