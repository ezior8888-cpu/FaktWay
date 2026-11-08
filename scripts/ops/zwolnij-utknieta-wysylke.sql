-- ════════════════════════════════════════════════════════════════
-- Faktura utknęła w wysyłce — wyjście operatora dla I2 i I1 (A5).
-- Woła go scripts/ops/zwolnij-utknieta-wysylke.sh:
--   psql -X -q -v id=<uuid faktury> -v wykonaj=0|1 -f zwolnij-utknieta-wysylke.sql
-- Runbook: docs/runbooks/hamulce-ksef.md, „Faktura utknęła w wysyłce (I1/I2)”.
-- Test na bazie: tests/rls-zwolnij-utknieta-wysylke.test.ts.
--
-- Warunki są lustrem strażnika `ksef_lifecycle_violations` (00148):
--   I2 — `sending` bez znacznika przejęcia albo przejęta ponad 30 min temu
--        (dzierżawa 15 min + 15 min). Automat tylko alarmuje, a RPC operatora
--        (`requeue_ksef_send`, `reset_ksef_send`) przyjmują wyłącznie
--        failed/rejected — bez tego skryptu faktura nie ma wyjścia.
--   I1 — `queued` ponad 15 min. Cron cyklu życia robi to samo co ten skrypt
--        co 15 min; skrypt jest dla sytuacji, gdy cron nie działa.
-- Oba tylko wtedy, gdy w pg-boss nie ma żywego zlecenia wysyłki tej faktury
-- (created/retry/active): żywe zlecenie samo przejmie fakturę po wygaśnięciu
-- dzierżawy (00124), a zwolnienie pod nim to wyścig.
--
-- Skutek (--wykonaj, jedna transakcja, wiersz faktury zablokowany na czas decyzji):
--   I2 → failed RESULT_UNCERTAIN, przejęcie zdjęte (`ksef_send_owner` NULL;
--        `submitted_to_ksef_at` zostaje jako ślad), audyt
--        `invoice.send_lease_released`. Dalej operator w /admin/ksef/<id>:
--        „Tylko uzgodnij” (otwarty wpis) albo „Wyślij ponownie” — runner
--        zaczyna od uzgodnienia, więc nie powstanie duplikat.
--   I1 → jak cron: `release_ksef_enqueue` (szkic, gdy nie ma dowodu kontaktu
--        z KSeF), inaczej failed ENQUEUE_LOST z audytem `invoice.enqueue_lost`.
-- Zapis wycofuje się (ROLLBACK), jeśli nie trafi dokładnie w jeden wiersz.
-- ════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
\pset footer off

\if :wykonaj
  BEGIN;
  -- Równoległe przejęcie przez workera albo ponowienie poczeka na koniec tej transakcji.
  SELECT count(*) AS zablokowano FROM (SELECT 1 FROM public.invoices WHERE id = :'id' FOR UPDATE) AS wiersz \gset
\endif

CREATE TEMP VIEW kandydat AS
  SELECT i.id, i.tenant_id, i.internal_number, i.ksef_status, i.last_error_code,
         i.ksef_send_owner, i.submitted_to_ksef_at, i.updated_at,
         (SELECT string_agg(j.state::text || ' ' || j.id::text, ', ' ORDER BY j.created_on)
            FROM pgboss.job j
           WHERE j.name = 'invoice.submit.requested'
             AND j.state IN ('created', 'retry', 'active')
             AND j.data->>'invoiceId' = i.id::text) AS zywe_zlecenia,
         public.ksef_has_contact_evidence(i.id, i.tenant_id) AS dowod_kontaktu,
         EXISTS (SELECT 1 FROM public.ksef_submissions s
                  WHERE s.invoice_id = i.id AND s.tenant_id = i.tenant_id
                    AND s.status IN ('sent', 'intent')) AS otwarty_wpis,
         CASE
           WHEN i.direction IS DISTINCT FROM 'outgoing' THEN NULL
           WHEN i.ksef_status = 'sending'
            AND (i.submitted_to_ksef_at IS NULL OR i.submitted_to_ksef_at < now() - interval '30 minutes') THEN 'I2'
           WHEN i.ksef_status = 'queued' AND i.updated_at < now() - interval '15 minutes' THEN 'I1'
         END AS inwariant
    FROM public.invoices i
   WHERE i.id = :'id';

\echo '--- faktura'
SELECT internal_number AS numer, ksef_status AS stan, last_error_code AS kod,
       ksef_send_owner AS przejecie, submitted_to_ksef_at AS przejeta_o, updated_at AS zmiana,
       coalesce(zywe_zlecenia, 'brak') AS zywe_zlecenia_pgboss, dowod_kontaktu, otwarty_wpis,
       coalesce(inwariant, 'brak') AS inwariant
  FROM kandydat;

SELECT coalesce(bool_or(inwariant = 'I2' AND zywe_zlecenia IS NULL), false) AS zwolnij_i2,
       coalesce(bool_or(inwariant = 'I1' AND zywe_zlecenia IS NULL), false) AS zwolnij_i1,
       CASE
         WHEN count(*) = 0 THEN 'NIE: nie ma faktury o tym id. Nic nie zmieniono.'
         WHEN bool_or(zywe_zlecenia IS NOT NULL) THEN
           'NIE: w pg-boss żyje zlecenie wysyłki tej faktury (kolumna zywe_zlecenia_pgboss) — worker sam ją przejmie po wygaśnięciu dzierżawy. Poczekaj i uruchom ponownie. Nic nie zmieniono.'
         WHEN bool_or(inwariant IS NULL) THEN
           'NIE: faktura nie jest w I2 (sending ponad 30 min albo bez znacznika przejęcia) ani w I1 (queued ponad 15 min). Nic nie zmieniono.'
         WHEN bool_or(inwariant = 'I2') THEN
           'TAK (I2): wysyłka przerwana bez wyniku — zwolnienie da failed RESULT_UNCERTAIN.'
         ELSE
           'TAK (I1): zlecenie zaginęło — zwolnienie jak cron cyklu życia: szkic bez dowodu kontaktu z KSeF, inaczej failed ENQUEUE_LOST.'
       END AS werdykt,
       CASE WHEN coalesce(bool_or(otwarty_wpis), false)
         THEN 'Dalej: /admin/ksef/' || :'id' || ' → „Tylko uzgodnij” (otwarty wpis wysyłki; po 48 h cron I5 uzgodni go sam).'
         ELSE 'Dalej: /admin/ksef/' || :'id' || ' → „Wyślij ponownie” (runner zaczyna od uzgodnienia — bez duplikatu) albo klient: „Wróć do szkicu”.'
       END AS dalej_i2,
       'Dalej: /admin/ksef/' || :'id' || ' → „Tylko uzgodnij” (otwarty wpis) albo „Wyślij ponownie”.' AS dalej_i1
  FROM kandydat \gset
\echo :werdykt

\if :wykonaj
  \if :zwolnij_i2
    WITH zapis AS (
      UPDATE public.invoices i
         SET ksef_status = 'failed',
             last_error_code = 'RESULT_UNCERTAIN',
             last_error = 'Wysyłka do KSeF przerwana bez wyniku (I2) — operator zwolnił przejęcie. Wynik ustali uzgodnienie z KSeF.',
             ksef_send_owner = NULL
        FROM kandydat k
       WHERE i.id = k.id AND i.tenant_id = k.tenant_id
         AND k.inwariant = 'I2' AND k.zywe_zlecenia IS NULL
         AND i.ksef_status = 'sending'
         AND i.submitted_to_ksef_at IS NOT DISTINCT FROM k.submitted_to_ksef_at
      RETURNING i.id, i.tenant_id, k.ksef_send_owner, k.submitted_to_ksef_at, k.dowod_kontaktu, k.otwarty_wpis
    ), audyt AS (
      SELECT public.ksef_send_audit(tenant_id, id, NULL, 'invoice.send_lease_released',
               jsonb_build_object('invariant', 'I2', 'code', 'RESULT_UNCERTAIN',
                                  'previous_owner', ksef_send_owner, 'submitted_to_ksef_at', submitted_to_ksef_at,
                                  'contact_evidence', dowod_kontaktu, 'open_submission', otwarty_wpis,
                                  'source', 'scripts/ops/zwolnij-utknieta-wysylke.sh'))
        FROM zapis
    )
    SELECT count(*) = 1 AS zapisano FROM audyt \gset
    \if :zapisano
      COMMIT;
      \echo 'ZWOLNIONO (I2): failed RESULT_UNCERTAIN, wpis audit_logs invoice.send_lease_released.'
      \echo :dalej_i2
    \else
      ROLLBACK;
      \echo 'Wycofano: zapis nie trafił dokładnie w jeden wiersz. Nic nie zmieniono.'
    \endif
  \elif :zwolnij_i1
    SELECT public.release_ksef_enqueue(k.id, k.tenant_id, 'operator: scripts/ops/zwolnij-utknieta-wysylke.sh (I1)') AS do_szkicu
      FROM kandydat k \gset
    \if :do_szkicu
      COMMIT;
      \echo 'ZWOLNIONO (I1): faktura wróciła do szkicu (bez dowodu kontaktu z KSeF), wpis audit_logs invoice.enqueue_released. Klient wyśle ją ponownie.'
    \else
      WITH zapis AS (
        UPDATE public.invoices i
           SET ksef_status = 'failed',
               last_error_code = 'ENQUEUE_LOST',
               last_error = 'Zlecenie wysyłki zaginęło, a faktura ma ślad kontaktu z KSeF — wymaga uzgodnienia przez operatora.',
               ksef_send_owner = NULL
          FROM kandydat k
         WHERE i.id = k.id AND i.tenant_id = k.tenant_id
           AND k.inwariant = 'I1' AND k.zywe_zlecenia IS NULL
           AND i.ksef_status = 'queued'
        RETURNING i.id, i.tenant_id, k.dowod_kontaktu, k.otwarty_wpis
      ), audyt AS (
        SELECT public.ksef_send_audit(tenant_id, id, NULL, 'invoice.enqueue_lost',
                 jsonb_build_object('invariant', 'I1', 'code', 'ENQUEUE_LOST',
                                    'contact_evidence', dowod_kontaktu, 'open_submission', otwarty_wpis,
                                    'source', 'scripts/ops/zwolnij-utknieta-wysylke.sh'))
          FROM zapis
      )
      SELECT count(*) = 1 AS zapisano FROM audyt \gset
      \if :zapisano
        COMMIT;
        \echo 'ZWOLNIONO (I1): failed ENQUEUE_LOST (faktura ma ślad kontaktu z KSeF), wpis audit_logs invoice.enqueue_lost.'
        \echo :dalej_i1
      \else
        ROLLBACK;
        \echo 'Wycofano: zapis nie trafił dokładnie w jeden wiersz. Nic nie zmieniono.'
      \endif
    \endif
  \else
    ROLLBACK;
  \endif
\else
  \echo 'Tryb podglądu — nic nie zmieniono. Zapis: ten sam skrypt z --wykonaj.'
\endif
