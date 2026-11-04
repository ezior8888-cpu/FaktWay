// Plan Finora P15 (E10b, §2.2): zaproszenie do firmy w układzie logowania
// Finory (`AuthSplitLayout`) zamiast szkła. Logika bez zmian (odczyt
// zaproszenia po skrócie tokenu, akceptacja w `InviteAcceptForm`).

import { createHash } from 'crypto';

import { AuthMessage } from '@/components/auth/finora/auth-message';
import { AuthSplitLayout } from '@/components/auth/finora/auth-split-layout';
import { InviteAcceptForm } from '@/components/invite/invite-accept-form';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { createAdminClient } from '@/lib/supabase/server';
import { requireVerifiedUserForPage } from '@/lib/auth/verified-user';

interface PageProps {
  params: Promise<{ token: string }>;
}

export default async function InviteLandingPage({ params }: PageProps) {
  const { token } = await params;

  if (!token || token.length < 16) {
    return (
      <FailureBox
        title="Nieprawidłowe zaproszenie"
        body="Link wygląda na uszkodzony. Skontaktuj się z osobą, która Cię zaprosiła."
      />
    );
  }

  const { user } = await requireVerifiedUserForPage('/invite/' + encodeURIComponent(token));
  const tokenHash = createHash('sha256').update(token).digest('hex');

  // Pobranie metadanych zaproszenia bypassem RLS — w tym widoku nie jesteśmy
  // członkiem org, więc RLS zakryłby wiersz. Pokazujemy tylko nazwę org +
  // adres docelowy maila — bez ujawniania wewnętrznych danych firmy.
  const admin = createAdminClient();
  const { data: invitation } = await admin
    .from('organization_invitations')
    .select(
      'id, email, role, accepted_at, revoked_at, expires_at, organization_id, tenants:organization_id(name)',
    )
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (!invitation) {
    return (
      <FailureBox
        title="Zaproszenie nie istnieje"
        body="Token jest nieprawidłowy. Może został zmieniony albo cały link nie został przeklejony."
      />
    );
  }

  if (invitation.revoked_at) {
    return (
      <FailureBox
        title="Zaproszenie zostało anulowane"
        body="Skontaktuj się z osobą, która Cię zaprosiła, aby wysłała nowe zaproszenie."
      />
    );
  }

  if (invitation.accepted_at) {
    return (
      <FailureBox
        title="Zaproszenie już użyte"
        body="To zaproszenie zostało już wcześniej zaakceptowane. Zaloguj się normalnie, aby zobaczyć organizację."
      />
    );
  }

  if (new Date(invitation.expires_at) <= new Date()) {
    return (
      <FailureBox
        title="Zaproszenie wygasło"
        body="Linki do zaproszeń są ważne 7 dni. Poproś osobę, która Cię zaprosiła, o nowe zaproszenie."
      />
    );
  }

  const tenant = Array.isArray(invitation.tenants)
    ? invitation.tenants[0]
    : invitation.tenants;
  const orgName = tenant?.name ?? 'organizacja';
  const inviteEmail = invitation.email as unknown as string;
  const userEmail = (user.email ?? '').toLowerCase();
  const emailMatches = inviteEmail.toLowerCase() === userEmail;

  return (
    <InviteLayout>
      <div>
        <h1 className="mb-2 text-2xl font-semibold">
          Zaproszenie do <span className="font-bold">{orgName}</span>
        </h1>
        <p className="text-muted-foreground">
          Zostałeś/aś zaproszony/a do organizacji <strong className="text-foreground">{orgName}</strong>{' '}
          w roli <strong className="text-foreground">{invitation.role}</strong>.
        </p>
      </div>

      {emailMatches ? (
        <InviteAcceptForm token={token} orgName={orgName} />
      ) : (
        <Alert role="status" className="border-amber-500/40 px-3 py-2.5">
          <AlertTitle className="text-sm">Niewłaściwe konto</AlertTitle>
          <AlertDescription className="text-sm/relaxed">
            Zaproszenie wysłano na <strong className="text-foreground">{inviteEmail}</strong>, ale jesteś
            zalogowany jako <strong className="text-foreground">{user.email}</strong>. Wyloguj się i
            zaloguj na właściwe konto.
          </AlertDescription>
        </Alert>
      )}
    </InviteLayout>
  );
}

function InviteLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthSplitLayout
      panelTitle="Dołącz do zespołu"
      panelText="Po akceptacji zobaczysz faktury i kontrahentów firmy w roli, którą nadała Ci osoba zapraszająca."
    >
      {children}
    </AuthSplitLayout>
  );
}

function FailureBox({ title, body }: { title: string; body: string }) {
  return (
    <InviteLayout>
      <div>
        <h1 className="mb-2 text-2xl font-semibold">{title}</h1>
      </div>
      <AuthMessage tone="error">{body}</AuthMessage>
    </InviteLayout>
  );
}
