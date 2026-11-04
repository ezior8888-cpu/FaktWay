-- 00153 — data rozpoczęcia działalności firmy (plan Finora E4, limit
-- zwolnienia z VAT).
--
-- Po co: limit zwolnienia podmiotowego z VAT (art. 113 ust. 1, 240 000 zł)
-- dla firmy, która rozpoczęła działalność w trakcie roku, liczy się
-- proporcjonalnie do dni działalności (art. 113 ust. 9). Bez daty startu
-- karta „Limit zwolnienia z VAT” zaniżyłaby wykorzystanie limitu firmie
-- z tego roku. Do tej pory data była tylko w profilu podatkowym agenta FLO
-- (`flo_prefs`), który nie jest wdrożony.
--
-- NULL = data nieznana (stan każdej istniejącej firmy). Karta pokazuje wtedy
-- samą sprzedaż i prośbę o uzupełnienie daty w ustawieniach, bez procentu.
--
-- Kolejność: PRZED wdrożeniem kodu (addytywna: nowa kolumna, CHECK na nowej
-- kolumnie, GRANT SELECT). Kod czyta kolumnę odpornie (brak kolumny = data
-- nieznana), ale zapis ustawienia wymaga kolumny.
--
-- Uprawnienia: od 00112 rola `authenticated` czyta kolumny `tenants` tylko
-- po jawnym GRANT SELECT (AUD-103; pilnuje
-- tests/unit/dane-ksef-uprawnienia-kolumn.test.ts). Zapis idzie kluczem
-- serwisowym w akcji `updateBusinessStartAction` po sprawdzeniu roli
-- właściciela albo administratora — bez nowych uprawnień UPDATE.
--
-- Bez DROP danych, bez UPDATE istniejących wierszy.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS business_started_on DATE;

ALTER TABLE public.tenants
  DROP CONSTRAINT IF EXISTS tenants_business_started_on_check;

-- Górną granicę (nie z przyszłości) pilnuje aplikacja: „dziś” w Polsce nie
-- jest wyrażeniem niezmiennym, a CHECK z current_date zależałby od strefy
-- sesji bazy.
ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_business_started_on_check
  CHECK (business_started_on IS NULL OR business_started_on >= DATE '1900-01-01');

GRANT SELECT (business_started_on) ON public.tenants TO authenticated;

COMMENT ON COLUMN public.tenants.business_started_on IS
  'Data rozpoczęcia działalności (limit zwolnienia z VAT proporcjonalnie, art. 113 ust. 9). NULL = nieznana.';
