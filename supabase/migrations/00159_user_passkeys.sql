-- 00159_user_passkeys.sql
--
-- Logowanie biometrią (FaktWay 1.0, sekcja 3 pkt 2): własny WebAuthn, bo natywne
-- passkeys Supabase są w becie i wymagają nowszego GoTrue z konfiguracją serwera.
-- Końcówki: app/api/auth/passkey/*, logika: lib/auth/passkey/*.
--
-- user_passkeys: urządzenia konta. Klucz publiczny nie jest sekretem, ale klient
-- go nie potrzebuje, więc `authenticated` czyta tylko kolumny listy urządzeń
-- (ten sam wzorzec co AUD-103 przy `tenants`). Zapis wyłącznie kluczem serwisowym,
-- po asercji w końcówce. Usuwanie: własne urządzenie, a na koncie z 2FA tylko
-- z sesji AAL2, żeby sesja AAL1 (samo hasło albo biometria) nie obeszła prośby
-- o kod bezpośrednim DELETE przez PostgREST.
--
-- webauthn_challenges: wyzwania jednorazowe, zużywane przez DELETE ... RETURNING
-- (lib/auth/passkey/challenges.ts). Bez dostępu dla `anon` i `authenticated`.
-- Wygasłe sprząta każde nowe wyzwanie, więc tabela nie rośnie.
--
-- PRZED wdrożeniem kodu (addytywna): nowe tabele i funkcja, stary kod ich nie zna.
-- Bez UPDATE danych, bez DROP. Po wgraniu: NOTIFY pgrst + schema_migrations
-- (AGENTS.md, „Wgrywanie migracji”). Wycofanie: DROP obu tabel i funkcji, tylko
-- za zgodą Bartosza (usuwa dodane urządzenia).

BEGIN;

CREATE TABLE public.user_passkeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Identyfikator poświadczenia z uwierzytelniacza, base64url. Po nim szukamy
  -- właściciela przy logowaniu (poświadczenia wykrywalne: bez pola e-mail).
  credential_id text NOT NULL UNIQUE CHECK (char_length(credential_id) BETWEEN 1 AND 1024),
  -- Klucz publiczny COSE, base64url.
  public_key text NOT NULL CHECK (char_length(public_key) BETWEEN 1 AND 4096),
  -- Licznik podpisów. Wiele platform wysyła zawsze 0, dlatego zapis warunkowy
  -- w końcówce porównuje poprzednią wartość, a nie tylko „większą”.
  counter bigint NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports text[] NOT NULL DEFAULT '{}',
  device_label text NOT NULL CHECK (char_length(device_label) BETWEEN 1 AND 60),
  -- Czy poświadczenie jest w kopii chmurowej (iCloud, Google).
  backed_up boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE INDEX idx_user_passkeys_user_id ON public.user_passkeys (user_id);

COMMENT ON TABLE public.user_passkeys IS
  'Urządzenia do logowania biometrią (WebAuthn). Zapis tylko service_role; użytkownik czyta i usuwa swoje.';

CREATE TABLE public.webauthn_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge text NOT NULL UNIQUE CHECK (char_length(challenge) BETWEEN 1 AND 512),
  purpose text NOT NULL CHECK (purpose IN ('registration', 'login')),
  -- Rejestracja należy do konta z sesji; logowanie jest przed sesją, więc konta nie ma.
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '5 minutes'),
  CONSTRAINT webauthn_challenges_user_matches_purpose
    CHECK ((purpose = 'registration') = (user_id IS NOT NULL))
);

CREATE INDEX idx_webauthn_challenges_expires_at ON public.webauthn_challenges (expires_at);
CREATE INDEX idx_webauthn_challenges_user_id ON public.webauthn_challenges (user_id) WHERE user_id IS NOT NULL;

COMMENT ON TABLE public.webauthn_challenges IS
  'Wyzwania WebAuthn: jednorazowe (DELETE ... RETURNING), wygasają po 5 minutach. Tylko service_role.';

-- Czy ta sesja może usunąć urządzenie: AAL2 albo konto bez zweryfikowanego
-- czynnika. `authenticated` nie ma odczytu `auth.mfa_factors`, stąd SECURITY DEFINER.
-- Oddaje jeden bit o własnym koncie, nic więcej.
CREATE FUNCTION public.session_may_manage_passkeys()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
    OR NOT EXISTS (
      SELECT 1 FROM auth.mfa_factors factor
      WHERE factor.user_id = auth.uid() AND factor.status = 'verified'
    );
$$;

REVOKE ALL ON FUNCTION public.session_may_manage_passkeys() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.session_may_manage_passkeys() TO authenticated, service_role;

ALTER TABLE public.user_passkeys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webauthn_challenges ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_passkeys_select_own ON public.user_passkeys
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY user_passkeys_delete_own ON public.user_passkeys
  FOR DELETE TO authenticated
  USING (user_id = auth.uid() AND public.session_may_manage_passkeys());

-- Supabase daje nowym tabelom pełne prawa dla anon i authenticated; zabieramy je jawnie.
REVOKE ALL ON public.user_passkeys FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, user_id, device_label, backed_up, created_at, last_used_at) ON public.user_passkeys TO authenticated;
GRANT DELETE ON public.user_passkeys TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_passkeys TO service_role;

-- Bez polityk: RLS odcina wszystko poza service_role. SELECT potrzebny też nocnej kopii
-- i strażnikowi `backup-readable-tables`, choć sama kopia tę tabelę pomija.
REVOKE ALL ON public.webauthn_challenges FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.webauthn_challenges TO service_role;

COMMIT;
