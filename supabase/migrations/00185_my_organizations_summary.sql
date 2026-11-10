-- ═══════════════════════════════════════════════════════════════
-- 00185: podsumowanie firm użytkownika („Moi klienci”, krok 6.2 planu
-- kompletnej aplikacji, część 2).
--
-- Księgowa z wieloma firmami klientów widzi ich listę z najważniejszymi
-- sprawami w jednym miejscu. Polityki RLS pokazują dane tylko AKTYWNEJ firmy
-- (nagłówek x-active-org, `get_current_tenant_id()` z 00037), więc lista wielu
-- firm przez RLS to kilka zapytań na każdą firmę z osobnym klientem. Zamiast
-- tego jedna funkcja SECURITY DEFINER, która:
--   * bierze firmy WYŁĄCZNIE z aktywnych członkostw `auth.uid()` (nagłówek
--     aktywnej firmy nie ma znaczenia, argumentu z id firmy nie ma);
--   * oddaje same liczby podsumowania, bez wierszy faktur i kosztów, bez
--     nabywców, bez poświadczeń KSeF (tylko flaga obecności i znaczniki
--     potwierdzenia, które layout panelu czyta już dla przełącznika firm);
--   * pomija firmy usunięte (`deleted_at`, RODO).
--
-- Liczby (te same warunki co w aplikacji, żeby ekran nie mówił czego innego
-- niż pulpit firmy):
--   * koszty do opisania: `expenses.is_reviewed = false`, jak kafel „Do
--     opisania” (`countExpensesToReview`, lib/dashboard/expense-stats.ts);
--   * faktury po terminie: warunki `getReceivables` (lib/dashboard/receivables.ts):
--     sprzedaż z aplikacji przyjęta w KSeF w środowisku z argumentu (KSEF_ENV
--     aplikacji), pary rodzaj i typ VAT/UPR, ZAL, ROZ, brutto powyżej zera,
--     wpłata nie ujemna, bez dzieci tej firmy (korekta przez parent_invoice_id,
--     ROZ przez advance_invoice_ids), do zapłaty dla ROZ z payment_data.amountDue
--     (ten sam wzór co wyzwalacz i widok z 00145), reszta po wpłatach powyżej
--     zera, termin przed dzisiejszym dniem w Polsce. Kwota w groszach, tylko
--     PLN albo bez waluty; waluta obca osobno jako liczba;
--   * przyjęte faktury bez środowiska KSeF: liczba, bo aplikacja wtedy nie
--     pokazuje kwot (getReceivables rzuca ten sam błąd).
--
-- Termin podatku i ZUS liczy aplikacja z kalendarza modułu (`terminDla`) tylko
-- dla firmy z `tenant_feature_flags.ksiegowosc_enabled`; baza oddaje flagę i
-- podstawę zwolnienia z VAT, nic więcej z modułu.
--
-- Kolejność: PRZED wdrożeniem. Addytywna: jedna nowa funkcja, bez zmian
-- tabel, danych i polityk; stara wersja aplikacji jej nie woła. Wycofanie:
-- usunięcie funkcji (za zgodą Bartosza). Po wgraniu: NOTIFY pgrst (AGENTS.md,
-- runbook wgrywania migracji). Rejestr: docs/koordynacja/CLAUDE-DO-CODEXA.md.
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.my_organizations_summary(p_ksef_environment text)
RETURNS TABLE (
  organization_id uuid,
  name text,
  nip text,
  role text,
  expenses_to_review bigint,
  overdue_count bigint,
  overdue_grosze bigint,
  overdue_foreign_count bigint,
  unknown_environment_count bigint,
  has_ksef_credentials boolean,
  ksef_verified_at timestamptz,
  ksef_verified_environment text,
  ksef_certificate_expiry timestamptz,
  vat_exemption_basis text,
  ksiegowosc_enabled boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  -- Dzień w Polsce, jak todayInWarsaw() w getReceivables: po północy UTC
  -- w Warszawie jest już następny dzień.
  v_today date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
BEGIN
  -- Środowisko z aplikacji (KSEF_ENV). Inna wartość to błąd wywołania, a nie
  -- „zero zaległości”.
  IF p_ksef_environment IS NULL OR p_ksef_environment NOT IN ('test', 'demo', 'production') THEN
    RAISE EXCEPTION 'my_organizations_summary: nieznane środowisko KSeF'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH firmy AS (
    -- Jedyne źródło firm: aktywne członkostwa zalogowanego. Klucz serwisowy
    -- i anon nie mają auth.uid(), więc dostałyby pustą listę (i tak nie mają
    -- prawa wykonania).
    SELECT m.organization_id AS org_id, m.role AS org_role
      FROM public.memberships AS m
     WHERE m.user_id = auth.uid()
       AND m.status = 'active'
  ),
  dzieci AS (
    -- Faktury tej samej firmy, które coś wskazują (korekta albo ROZ), w każdym
    -- statusie i kierunku, jak loadTenantChildIds.
    SELECT c.tenant_id, c.parent_invoice_id AS invoice_id
      FROM public.invoices AS c
      JOIN firmy AS f ON f.org_id = c.tenant_id
     WHERE c.parent_invoice_id IS NOT NULL
    UNION
    SELECT c.tenant_id, pg_catalog.unnest(c.advance_invoice_ids) AS invoice_id
      FROM public.invoices AS c
      JOIN firmy AS f ON f.org_id = c.tenant_id
     WHERE pg_catalog.cardinality(c.advance_invoice_ids) > 0
  ),
  kandydaci AS (
    -- Zawężenie odczytu z getReceivables (bez środowiska, żeby policzyć
    -- przyjęte faktury bez niego).
    SELECT i.id, i.tenant_id, i.ksef_environment, i.invoice_kind, i.invoice_type,
           i.currency, i.gross_total, i.paid_amount, i.payment_due_date, i.payment_data
      FROM public.invoices AS i
      JOIN firmy AS f ON f.org_id = i.tenant_id
     WHERE i.direction = 'outgoing'
       AND i.origin = 'app'
       AND i.ksef_status = 'accepted'
       AND i.payment_status IN ('unpaid', 'partial', 'overdue')
       AND i.invoice_kind IN ('regular', 'advance', 'final')
       AND i.invoice_type IN ('VAT', 'UPR', 'ZAL', 'ROZ')
       AND i.gross_total > 0
  ),
  naleznosci AS (
    SELECT k.tenant_id,
           k.currency,
           k.payment_due_date,
           GREATEST(
             0,
             round(
               (CASE
                  WHEN k.invoice_kind = 'final'
                       AND (k.payment_data ->> 'amountDue') ~ '^[0-9]+(\.[0-9]+)?$'
                  THEN LEAST((k.payment_data ->> 'amountDue')::numeric, k.gross_total)
                  ELSE k.gross_total
                END) - k.paid_amount,
               2
             )
           ) AS do_zaplaty
      FROM kandydaci AS k
     WHERE k.ksef_environment = p_ksef_environment
       AND (
         (k.invoice_kind = 'regular' AND k.invoice_type IN ('VAT', 'UPR')) OR
         (k.invoice_kind = 'advance' AND k.invoice_type = 'ZAL') OR
         (k.invoice_kind = 'final' AND k.invoice_type = 'ROZ')
       )
       AND k.paid_amount >= 0
       AND NOT EXISTS (
         SELECT 1
           FROM dzieci AS d
          WHERE d.tenant_id = k.tenant_id
            AND d.invoice_id = k.id
       )
  ),
  po_terminie AS (
    SELECT n.tenant_id,
           count(*) FILTER (WHERE n.currency IS NULL OR n.currency = 'PLN') AS liczba,
           COALESCE(sum(n.do_zaplaty) FILTER (WHERE n.currency IS NULL OR n.currency = 'PLN'), 0) AS suma,
           count(*) FILTER (WHERE n.currency IS NOT NULL AND n.currency <> 'PLN') AS waluta_obca
      FROM naleznosci AS n
     WHERE n.do_zaplaty > 0
       AND n.payment_due_date < v_today
     GROUP BY n.tenant_id
  ),
  bez_srodowiska AS (
    SELECT k.tenant_id, count(*) AS liczba
      FROM kandydaci AS k
     WHERE k.ksef_environment IS NULL
        OR k.ksef_environment NOT IN ('test', 'demo', 'production')
     GROUP BY k.tenant_id
  ),
  koszty AS (
    SELECT e.tenant_id, count(*) AS do_opisania
      FROM public.expenses AS e
      JOIN firmy AS f ON f.org_id = e.tenant_id
     WHERE e.is_reviewed = false
     GROUP BY e.tenant_id
  )
  SELECT t.id,
         t.name::text,
         t.nip::text,
         f.org_role::text,
         COALESCE(ko.do_opisania, 0)::bigint,
         COALESCE(pt.liczba, 0)::bigint,
         (COALESCE(pt.suma, 0) * 100)::bigint,
         COALESCE(pt.waluta_obca, 0)::bigint,
         COALESCE(bs.liczba, 0)::bigint,
         COALESCE(t.has_ksef_credentials, false),
         t.ksef_verified_at,
         t.ksef_verified_environment::text,
         t.ksef_certificate_expiry,
         t.vat_exemption_basis::text,
         COALESCE(ff.ksiegowosc_enabled, false)
    FROM firmy AS f
    JOIN public.tenants AS t ON t.id = f.org_id
    LEFT JOIN public.tenant_feature_flags AS ff ON ff.tenant_id = t.id
    LEFT JOIN koszty AS ko ON ko.tenant_id = t.id
    LEFT JOIN po_terminie AS pt ON pt.tenant_id = t.id
    LEFT JOIN bez_srodowiska AS bs ON bs.tenant_id = t.id
   WHERE t.deleted_at IS NULL;
END;
$$;

COMMENT ON FUNCTION public.my_organizations_summary(text) IS
  'Moi klienci (krok 6.2): liczby podsumowania firm z aktywnym członkostwem auth.uid(); koszty do opisania, faktury po terminie w groszach, status KSeF i flaga modułu księgowości. Bez wierszy dokumentów.';

-- Supabase nadaje EXECUTE rolom anon i authenticated jawnie, samo FROM PUBLIC nic
-- nie odbiera (AUD-30). Tylko sesja zalogowanego: klucz serwisowy nie ma auth.uid().
REVOKE ALL ON FUNCTION public.my_organizations_summary(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.my_organizations_summary(text) TO authenticated;
