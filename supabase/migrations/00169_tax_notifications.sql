-- ═══════════════════════════════════════════════════════════════
-- 00169: przypomnienia modułu księgowości (plan
-- docs/koordynacja/PLAN-KSIEGOWOSC-JDG.md, krok K5, sekcja 9)
--
-- KIEDY WGRAĆ: PRZED wdrożeniem. Nowa tabela i kolumna z wartością
-- domyślną; bez DROP tabel i kolumn, bez zmiany istniejących danych.
--
-- 1. tax_notifications: jedno powiadomienie na firmę, rozliczenie i etap
--    (UNIQUE), czyli klucz idempotencji dwóch cronów:
--    - cron.ksiegowosc-miesiac (1-3. dnia miesiąca): „rozliczenie za marzec
--      jest wyliczone”, etap `wyliczone`;
--    - cron.ksiegowosc-terminy (codziennie): przypomnienie 5 i 1 dzień przed
--      terminem, etap `termin-5:RRRR-MM-DD` albo `termin-1:RRRR-MM-DD`.
--    Wpis powstaje PRZED wysyłką („sending”), więc ponowienie zadania od
--    zera nie wyśle drugi raz; „failed” i przerwane „sending” wolno przejąć
--    (wzór billing_notifications z 00048). Szkic rozliczenia nie trafia do
--    bazy (00168), więc idempotencję obu cronów trzyma ta tabela.
--    Piszą i czytają tylko zadania (service_role); klient jej nie widzi.
--
-- 2. push_subscriptions.notify_ksiegowosc: zgoda na powiadomienia push
--    modułu (przełącznik w ustawieniach powiadomień widzi tylko firma
--    w pilotażu). Domyślnie TRUE jak pozostałe zgody transakcyjne; grant na
--    tabelę z 00032 obejmuje kolumnę.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.tax_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  -- Miesiąc rozliczenia RRRR-MM.
  rozliczenie TEXT NOT NULL,
  etap TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sending',
  -- Wynik wysyłki: liczba pushy, identyfikator maila (bez treści i adresów).
  wynik JSONB NOT NULL DEFAULT '{}'::jsonb,
  blad TEXT,
  utworzono_o TIMESTAMPTZ NOT NULL DEFAULT now(),
  wyslano_o TIMESTAMPTZ,
  CONSTRAINT tax_notifications_unikalne UNIQUE (tenant_id, rozliczenie, etap),
  CONSTRAINT tax_notifications_rozliczenie_check CHECK (rozliczenie ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
  CONSTRAINT tax_notifications_etap_check CHECK (etap ~ '^(wyliczone|termin-[15]:20[0-9]{2}-[01][0-9]-[0-3][0-9])$'),
  CONSTRAINT tax_notifications_status_check CHECK (status IN ('sending', 'sent', 'failed')),
  CONSTRAINT tax_notifications_blad_check CHECK (blad IS NULL OR char_length(blad) <= 500)
);

COMMENT ON TABLE public.tax_notifications IS
  'Powiadomienia modułu księgowości (K5): klucz idempotencji cronów ksiegowosc-miesiac i ksiegowosc-terminy. Tylko service_role.';

ALTER TABLE public.tax_notifications ENABLE ROW LEVEL SECURITY;

-- Bez polityk dla authenticated: tabelę czytają i piszą tylko zadania.
REVOKE ALL ON public.tax_notifications FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tax_notifications TO service_role;

ALTER TABLE public.push_subscriptions ADD COLUMN IF NOT EXISTS notify_ksiegowosc BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN public.push_subscriptions.notify_ksiegowosc IS
  'Zgoda na push modułu księgowości: rozliczenie miesiąca i terminy (K5).';

NOTIFY pgrst, 'reload schema';
