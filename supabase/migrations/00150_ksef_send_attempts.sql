-- 00150_ksef_send_attempts.sql
--
-- A5 z planu „zero zgubionych faktur” (docs/koordynacja/PLAN-ZERO-ZGUBIONYCH-FAKTUR.md)
-- i kontrakt danych centrum dowodzenia (CENTRUM-DOWODZENIA-BRIEF-DLA-CODEXA.md, §5):
-- dziennik prób wysyłki do KSeF. Jeden wiersz na jedno wykonanie joba wysyłki
-- (job pg-boss) oraz na każdą odmowę wysyłki PRZED kolejką (hamulce, MFA,
-- certyfikat — `status = 'refused'`, `stage = 'enqueue'`).
--
-- Po co: porażka przed wysłaniem pliku (poświadczenia, XML, przejęcie) nie
-- zostawia wiersza w `ksef_submissions`, a `invoices.last_error*` trzyma tylko
-- OSTATNI błąd — kolejna próba go nadpisuje. Ponowienie (nowy job) to nowy
-- wiersz, więc porażki odzyskanych wysyłek zostają w historii.
--
-- Odstępstwo od briefu §5 (kolumny w `ksef_submissions` z UNIQUE
-- `send_attempt_id`), zatwierdzone z poprawką po A2: po A2 jedna próba
-- (`sendAttemptId`) ma kilka sesji KSeF i kilka wykonań, a statusy
-- `ksef_submissions` są dowodem kontaktu z KSeF (`ksef_has_contact_evidence`,
-- I5, duplikaty 440). Osobna tabela nie wpływa na żadną decyzję wysyłki:
-- nic w runnerze ani w funkcjach z 00131–00148 jej nie czyta.
--
-- Zapis wyłącznie kluczem serwisowym (worker, akcja serwera po odmowie).
-- RLS włączony bez polityk: klient i księgowy nie czytają (widok klienta
-- to osobna faza centrum). Treść błędu bez danych klienta (`sendAttemptMessage`:
-- `scrubTelemetryText`, maskowanie NIP, rachunków, kwot i wartości pól w
-- cudzysłowach), najwyżej 500 znaków (CHECK). Retencja: wiersze żyją z fakturą (CASCADE);
-- osobnego czyszczenia nie ma — `cleanup_old_audit_logs` tej tabeli nie
-- dotyka (polityka F0: minimalny ślad błędu faktury 10 lat).
--
-- PRZED wdrożeniem kodu (addytywna): nowa tabela, stary kod jej nie zna.
-- Bez UPDATE danych, bez DROP. Wycofanie: DROP TABLE public.ksef_send_attempts
-- (tylko za zgodą — usuwa historię prób).

BEGIN;

CREATE TABLE public.ksef_send_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  -- `sendAttemptId` zdarzenia (= `invoices.ksef_send_owner`, `audit_logs.metadata.sendAttemptId`);
  -- NULL przy odmowie przed kolejką i przy zdarzeniach sprzed AUD-10.
  send_attempt_id uuid,
  -- Id joba pg-boss tego wykonania (= `inngest_run_log.run_id`); ponowienie = nowy job.
  job_id uuid,
  -- 0-based numer wykonania z pg-boss (`__attempt`); oczekiwanie go nie zwiększa.
  execution integer NOT NULL DEFAULT 0 CHECK (execution >= 0),
  ksef_environment text,
  worker_sha text CHECK (char_length(worker_sha) <= 64),
  status text NOT NULL CHECK (status IN ('started', 'succeeded', 'failed', 'waiting', 'refused')),
  -- Etap, na którym wykonanie się skończyło (lib/ksef/send-attempt-ledger.ts, SEND_ATTEMPT_STAGES).
  stage text NOT NULL DEFAULT 'start' CHECK (char_length(stage) <= 32),
  -- Wynik udanego wykonania: accepted / already_accepted / retired / offline_redirect / completed.
  result text CHECK (char_length(result) <= 32),
  -- Kod i klasa z katalogu `ksef_error_codes` w chwili zdarzenia (odmowa przed kolejką: kod odmowy).
  error_code text CHECK (char_length(error_code) <= 40),
  error_class text CHECK (char_length(error_class) <= 20),
  error_message text CHECK (char_length(error_message) <= 500),
  ksef_http_status integer,
  -- Kod KSeF z odpowiedzi (np. 440, 450, kod wyjątku API).
  ksef_code integer,
  -- false = bez ponowień (`NonRetriableError`); true = runner zlecił ponowienie, o ile zostały próby.
  retryable boolean,
  -- Kto kliknął przy odmowie przed kolejką; NULL dla workera. SET NULL przy
  -- usunięciu konta (RODO), jak `audit_logs.user_id`.
  user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  -- Oba znaczniki z zegara piszącego (worker, akcja serwera); bez CHECK
  -- kolejności — różnica zegarów albo korekta NTP nie może odrzucić zapisu
  -- wyniku (wiersz bez wyniku wyglądałby jak przerwane wykonanie).
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

COMMENT ON TABLE public.ksef_send_attempts IS
  'A5: dziennik prób wysyłki do KSeF — wiersz na wykonanie joba wysyłki i na odmowę przed kolejką. Tylko opis (centrum dowodzenia); żadna decyzja wysyłki go nie czyta. Zapis wyłącznie service_role.';

CREATE INDEX idx_ksef_send_attempts_invoice ON public.ksef_send_attempts (tenant_id, invoice_id, started_at DESC);
CREATE INDEX idx_ksef_send_attempts_started ON public.ksef_send_attempts (started_at DESC);
CREATE INDEX idx_ksef_send_attempts_errors ON public.ksef_send_attempts (started_at DESC)
  WHERE status IN ('failed', 'refused');

ALTER TABLE public.ksef_send_attempts ENABLE ROW LEVEL SECURITY;

-- Domyślne uprawnienia Supabase dają ALL na nowej tabeli także service_role —
-- samo GRANT niżej nie odbiera DELETE/TRUNCATE. Historia prób zostaje; wiersze
-- znikają wyłącznie z fakturą albo firmą (CASCADE działa bez prawa DELETE).
REVOKE ALL ON public.ksef_send_attempts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.ksef_send_attempts TO service_role;

COMMIT;
