-- ════════════════════════════════════════════════════════════════
-- Faktura zapisana z KSeF decyzją klienta bez daty nadania numeru (I3K,
-- „no_date”): uzupełnienie `ksef_accepted_at` (D-A4-1b-3 PR C, 00156).
-- Woła go scripts/ops/oryginal-ksef-data-nadania.sh:
--   psql -X -q -v id=<uuid faktury K> -v iso=<czas z KSeF> -v wykonaj=0|1 -f oryginal-ksef-data-nadania.sql
-- Runbook: docs/runbooks/ksef-error-codes.md, „Brak daty nadania”.
-- Test na bazie: tests/rls-oryginal-data-nadania.test.ts.
--
-- Skąd ten stan. Zapis oryginału (`decide_ksef_duplicate_original`) bierze datę
-- z `original_check.acquiredAt` i nigdy nie wstawia `now()` (INV-16): data
-- nadania numeru KSeF jest datą wystawienia faktury w sensie art. 106na. Gdy
-- runner nie zdobył daty, faktura K ma `ksef_accepted_at IS NULL`, strażnik
-- pokazuje ją jako I3K (`no_date`), a Sentry dostaje
-- `ksef-duplicate-import-no-date`.
--
-- Warunki (jedno zapytanie, to samo dla podglądu i zapisu). Zapis tylko, gdy:
--   - faktura K jest `accepted`,
--   - powstała z tej decyzji: `fa3_data->'import'->>'source' = 'ksef_duplicate_decision'`,
--   - jest tą fakturą, którą pokazuje I3K: sprzedaż z `origin = 'ksef_import'`,
--     na którą wskazuje `decision.importedInvoiceId` wpisu `number_taken`,
--   - nie ma jeszcze daty (`ksef_accepted_at IS NULL`); raz zapisanej tym
--     skryptem nie zmienisz (zmiana: tylko rola serwisowa, za zgodą Bartosza),
--   - podany czas jest pełnym czasem ISO 8601 ze strefą (Z albo +hh:mm), jest
--     prawdziwą datą i nie pochodzi z przyszłości.
-- Zapis (--wykonaj): jedna transakcja, wiersz zablokowany, dokładnie jeden
-- zmieniony wiersz i jeden wpis audit_logs `invoice.ksef_accepted_at_backfilled`,
-- inaczej ROLLBACK.
--
-- Ostrzeżenie (bez blokady): numer KSeF zawiera datę przyjęcia (NIP-RRRRMMDD-…).
-- Gdy podana data różni się od niej o więcej niż dobę, podgląd to pisze. To
-- najczęstsza pomyłka przy przepisywaniu z Aplikacji Podatnika.
-- ════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
\pset footer off

-- Pomocnicze funkcje tymczasowe (znikają z sesją): rzutu, który się nie uda
-- (30 lutego), nie wolno zostawić błędowi SQL, bo wtedy operator zobaczy
-- trace zamiast zdania „NIE: …”.
CREATE FUNCTION pg_temp.czas_iso(t text) RETURNS timestamptz LANGUAGE plpgsql AS $f$
BEGIN
  RETURN t::timestamptz;
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$f$;

CREATE FUNCTION pg_temp.data_z_numeru(n text) RETURNS date LANGUAGE plpgsql AS $f$
BEGIN
  IF n !~ '^[0-9]{10}-[0-9]{8}-' THEN RETURN NULL; END IF;
  RETURN to_date(substring(n from 12 for 8), 'YYYYMMDD');
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$f$;

CREATE TEMP VIEW wejscie AS
  SELECT :'iso' AS iso,
         coalesce(:'iso' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$', false) AS format_ok,
         CASE WHEN coalesce(:'iso' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$', false)
              THEN pg_temp.czas_iso(:'iso') END AS czas;

CREATE TEMP VIEW kandydat AS
  SELECT i.id, i.tenant_id, i.internal_number, i.ksef_number, i.ksef_status, i.origin, i.issue_date,
         i.ksef_accepted_at,
         i.fa3_data->'import'->>'source' AS zrodlo,
         i.ksef_status = 'accepted' AS przyjeta,
         coalesce(i.fa3_data->'import'->>'source' = 'ksef_duplicate_decision', false) AS z_decyzji,
         i.ksef_accepted_at IS NULL AS bez_daty,
         (i.origin = 'ksef_import' AND i.direction = 'outgoing'
          AND EXISTS (SELECT 1 FROM public.ksef_submissions m
                       WHERE m.status = 'number_taken'
                         AND m.original_check->'decision'->>'importedInvoiceId' = i.id::text)) AS jak_w_i3k,
         pg_temp.data_z_numeru(i.ksef_number) AS data_w_numerze
    FROM public.invoices i
   WHERE i.id = :'id';

\echo '--- faktura K'
SELECT internal_number AS numer, ksef_number AS numer_ksef, ksef_status AS stan, origin,
       coalesce(zrodlo, '-') AS zrodlo_zapisu, ksef_accepted_at AS data_nadania_teraz,
       data_w_numerze AS data_w_numerze_ksef
  FROM kandydat;

\echo '--- podana data'
SELECT iso AS podany_czas, format_ok AS format_iso, czas AS czas_utc,
       (czas AT TIME ZONE 'Europe/Warsaw') AS czas_warszawa
  FROM wejscie;

SELECT (SELECT count(*) = 1 FROM kandydat) AS jest_faktura,
       (SELECT format_ok FROM wejscie) AS format_ok,
       (SELECT czas IS NOT NULL FROM wejscie) AS prawdziwa_data,
       coalesce((SELECT czas <= now() + interval '5 minutes' FROM wejscie), false) AS nie_z_przyszlosci,
       coalesce((SELECT przyjeta FROM kandydat), false) AS przyjeta,
       coalesce((SELECT z_decyzji FROM kandydat), false) AS z_decyzji,
       coalesce((SELECT jak_w_i3k FROM kandydat), false) AS jak_w_i3k,
       coalesce((SELECT bez_daty FROM kandydat), false) AS bez_daty,
       coalesce((SELECT abs(((czas AT TIME ZONE 'Europe/Warsaw')::date) - k.data_w_numerze) > 1
                   FROM wejscie w, kandydat k
                  WHERE w.czas IS NOT NULL AND k.data_w_numerze IS NOT NULL), false) AS rozjazd_z_numerem \gset

SELECT :'jest_faktura'::boolean AND :'format_ok'::boolean AND :'prawdziwa_data'::boolean
       AND :'nie_z_przyszlosci'::boolean AND :'przyjeta'::boolean AND :'z_decyzji'::boolean
       AND :'jak_w_i3k'::boolean AND :'bez_daty'::boolean AS gotowe,
       CASE
         WHEN NOT :'format_ok'::boolean THEN
           'NIE: podany czas nie ma postaci pełnego czasu ISO 8601 ze strefą, np. 2026-10-08T12:34:56Z albo 2026-10-08T14:34:56+02:00. Nic nie zmieniono.'
         WHEN NOT :'prawdziwa_data'::boolean THEN
           'NIE: podany czas nie jest prawdziwą datą (np. 30 lutego albo godzina 25). Nic nie zmieniono.'
         WHEN NOT :'nie_z_przyszlosci'::boolean THEN
           'NIE: podany czas jest z przyszłości, a data nadania numeru KSeF nie może być późniejsza niż teraz. Nic nie zmieniono.'
         WHEN NOT :'jest_faktura'::boolean THEN
           'NIE: nie ma faktury o tym id. Nic nie zmieniono.'
         WHEN NOT :'przyjeta'::boolean THEN
           'NIE: faktura nie jest przyjęta (stan w tabeli wyżej), a datę nadania ma tylko faktura przyjęta. Nic nie zmieniono.'
         WHEN NOT :'z_decyzji'::boolean THEN
           'NIE: to nie jest faktura zapisana decyzją przy nierozstrzygniętym 440 (fa3_data.import.source ≠ ksef_duplicate_decision). Datę faktur z importu historii ustala sam import. Nic nie zmieniono.'
         WHEN NOT :'jak_w_i3k'::boolean THEN
           'NIE: to nie jest faktura K, którą pokazuje I3K: sprzedaż z importu (origin ksef_import), na którą wskazuje decyzja (wpis number_taken z importedInvoiceId). Nic nie zmieniono.'
         WHEN NOT :'bez_daty'::boolean THEN
           'NIE: faktura ma już datę nadania (tabela wyżej), tym skryptem jej nie zmienisz. Zmiana tylko rolą serwisową, za zgodą Bartosza. Nic nie zmieniono.'
         ELSE
           'TAK: faktura zapisana z KSeF decyzją klienta, przyjęta, bez daty nadania. Można ją uzupełnić podanym czasem.'
       END AS werdykt \gset
\echo :werdykt
\if :rozjazd_z_numerem
  \echo 'UWAGA: data w numerze KSeF (tabela „faktura K”) różni się od podanej o więcej niż dobę. Sprawdź jeszcze raz datę w Aplikacji Podatnika KSeF, zanim zapiszesz.'
\endif

\if :wykonaj
  \if :gotowe
    BEGIN;
    -- Równoległa zmiana tej faktury (worker, drugi operator) poczeka na koniec tej transakcji.
    SELECT count(*) AS zablokowano FROM (SELECT 1 FROM public.invoices WHERE id = :'id' FOR UPDATE) AS wiersz \gset
    WITH zapis AS (
      UPDATE public.invoices i
         SET ksef_accepted_at = w.czas
        FROM wejscie w
       WHERE i.id = :'id'
         AND i.ksef_accepted_at IS NULL
         AND i.ksef_status = 'accepted'
         AND i.fa3_data->'import'->>'source' = 'ksef_duplicate_decision'
         AND i.origin = 'ksef_import' AND i.direction = 'outgoing'
         AND EXISTS (SELECT 1 FROM public.ksef_submissions m
                      WHERE m.status = 'number_taken'
                        AND m.original_check->'decision'->>'importedInvoiceId' = i.id::text)
         AND w.format_ok AND w.czas IS NOT NULL AND w.czas <= now() + interval '5 minutes'
      RETURNING i.id, i.tenant_id, i.ksef_number, i.ksef_accepted_at
    ), audyt AS (
      INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, details_json)
      SELECT tenant_id, NULL, 'invoice.ksef_accepted_at_backfilled', 'invoice', id,
             jsonb_build_object('ksef_number', ksef_number,
                                'previous_ksef_accepted_at', NULL,
                                'ksef_accepted_at', ksef_accepted_at,
                                'given_iso', :'iso',
                                'source', 'scripts/ops/oryginal-ksef-data-nadania.sh',
                                'runbook', 'ksef-error-codes.md: Brak daty nadania')
        FROM zapis
      RETURNING entity_id
    )
    SELECT count(*) = 1 AS zapisano FROM audyt \gset
    \if :zapisano
      COMMIT;
      \echo 'ZAPISANO ksef_accepted_at i wpis audit_logs invoice.ksef_accepted_at_backfilled.'
      \echo 'Dalej: I3K „no_date” znika od razu (strażnik liczy na bieżąco: /admin/ksef, sekcja 10 (l) kontrola-faktur-ksef.sh). Jeśli I3K zostaje, to brak sesji UPO (runbook „UPO faktury zapisanej z KSeF”).'
    \else
      ROLLBACK;
      \echo 'Wycofano: zapis nie trafił dokładnie w jeden wiersz. Nic nie zmieniono.'
    \endif
  \endif
\else
  \echo 'Tryb podglądu: nic nie zmieniono. Zapis: ten sam skrypt z --wykonaj.'
\endif
