'use client';

// Plan Finora P15 (E10b): kreator na prymitywach Finory (`Tabs`, `Alert`,
// `InputGroup`, `Button`, ikony Remix) zamiast szkła. Logika i akcje bez
// zmian; `id` pól (`nip`, `invite-token`, `nip-join`) i nazwy zakładek
// pilnuje `e2e/pages/onboarding-page.ts`.

import { useState, useTransition, type ReactNode } from 'react';
import {
  RiAlertLine,
  RiArrowRightLine,
  RiBuilding2Line,
  RiCheckboxCircleLine,
  RiErrorWarningLine,
  RiLoader4Line,
  RiMailLine,
  RiSearchLine,
  RiShieldCheckLine,
  RiUserAddLine,
} from '@remixicon/react';

import {
  acceptInvitationAction,
  requestJoinAction,
  skipOnboardingWithoutNipAction,
} from '@/app/actions/organizations';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';

import {
  completeOnboardingAction,
  lookupNipAction,
  type NipMatch,
  type OnboardingCompanyData,
} from './actions';

type Tab = 'create' | 'invite' | 'join';

export function OnboardingForm({
  initialInviteToken,
}: {
  initialInviteToken?: string;
}) {
  const [tab, setTab] = useState<Tab>(initialInviteToken ? 'invite' : 'create');

  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="gap-6">
      <TabsList className="w-full">
        <OnboardingTab value="create" icon={<RiBuilding2Line />} label="Załóż firmę" />
        <OnboardingTab value="invite" icon={<RiMailLine />} label="Mam zaproszenie" />
        <OnboardingTab value="join" icon={<RiUserAddLine />} label="Poproś o dostęp" />
      </TabsList>

      <TabsContent value="create">
        <CreateOrgPanel />
      </TabsContent>
      <TabsContent value="invite">
        <AcceptInvitePanel initialToken={initialInviteToken ?? ''} />
      </TabsContent>
      <TabsContent value="join">
        <RequestJoinPanel />
      </TabsContent>
    </Tabs>
  );
}

function OnboardingTab({ value, icon, label }: { value: Tab; icon: ReactNode; label: string }) {
  // Na telefonie zostaje sama ikona (trzy etykiety nie mieszczą się w 375 px),
  // więc nazwę zakładki niesie `aria-label`.
  return (
    <TabsTrigger value={value} aria-label={label}>
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </TabsTrigger>
  );
}

/** Błąd akcji — `Alert` Finory w wariancie `destructive`. */
function FormError({ children }: { children: ReactNode }) {
  return (
    <Alert variant="destructive" className="border-destructive/30">
      <RiErrorWarningLine />
      <AlertDescription className="text-sm/relaxed text-destructive">{children}</AlertDescription>
    </Alert>
  );
}

/** Wyjaśnienie nad polem — wyciszony blok. */
function Note({ children }: { children: ReactNode }) {
  return <p className="border bg-muted/50 p-3 text-sm/relaxed text-muted-foreground">{children}</p>;
}

const FIELD_LABEL_CLASS = 'leading-5';

// ═══════════════════════════════════════════════════════════════
// Panel: Załóż firmę
// ═══════════════════════════════════════════════════════════════

function CreateOrgPanel() {
  const [nipInput, setNipInput] = useState('');
  const [company, setCompany] = useState<OnboardingCompanyData | null>(null);
  const [duplicates, setDuplicates] = useState<NipMatch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [isSearching, startSearching] = useTransition();
  const [isSubmitting, startSubmitting] = useTransition();
  const [isSkipping, startSkipping] = useTransition();

  const handleSkip = () => {
    setError(null);
    startSkipping(async () => {
      // Po sukcesie akcja robi server-side redirect → /dashboard (nie returnsuje).
      const result = await skipOnboardingWithoutNipAction();
      if (!result.success) {
        setError(result.error);
      }
    });
  };

  const handleLookup = () => {
    setError(null);
    setInfo(null);
    setCompany(null);
    setDuplicates([]);
    startSearching(async () => {
      const result = await lookupNipAction(nipInput);
      if (result.success) {
        setCompany(result.data);
        setDuplicates(result.existingOrgs);
        if (result.existingOrgs.some((o) => o.ksefVerified)) {
          setInfo(
            'Inna organizacja z tym NIP-em jest już zweryfikowana w KSeF. Jeśli to Twoja firma — poproś o dostęp zamiast tworzyć duplikat.',
          );
        } else if (result.existingOrgs.length > 0) {
          setInfo(
            'Już istnieje konto firmy z tym NIP-em. Możesz mimo to założyć osobną organizację albo poprosić o dostęp do istniejącej.',
          );
        }
      } else {
        setError(result.error);
      }
    });
  };

  const handleConfirm = () => {
    if (!company) return;
    startSubmitting(async () => {
      // completeOnboardingAction → createOrganizationAction wykonuje redirect
      // server-side po sukcesie (Set-Cookie + 303 atomowo). Tu obsługujemy
      // tylko ścieżkę błędu — przy sukcesie funkcja nie returnsuje.
      const result = await completeOnboardingAction(company);
      if (!result.success) {
        setError(result.error);
      }
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <Label htmlFor="nip" className={FIELD_LABEL_CLASS}>
          NIP firmy*
        </Label>
        <InputGroup className="h-10">
          <InputGroupInput
            id="nip"
            value={nipInput}
            onChange={(e) => setNipInput(e.target.value.replace(/\D/g, ''))}
            placeholder="Wpisz 10 cyfr NIP"
            maxLength={10}
            inputMode="numeric"
            disabled={isSearching || !!company}
            className="font-mono text-base"
          />
          <InputGroupAddon align="inline-end" className="pr-1.5">
            <Button
              onClick={handleLookup}
              variant="ghost"
              size="icon"
              aria-label="Szukaj firmy w GUS"
              disabled={nipInput.length !== 10 || isSearching || !!company}
            >
              {isSearching ? (
                <RiLoader4Line className="size-5 animate-spin" />
              ) : (
                <RiSearchLine className="size-5" />
              )}
            </Button>
          </InputGroupAddon>
        </InputGroup>
        <p className="text-xs text-muted-foreground">
          Pobierzemy dane firmy z bazy GUS REGON. NIP nie nadaje uprawnień —
          sam NIP jest publiczny, a dostęp do organizacji wymaga zaproszenia
          lub potwierdzonego ownership w KSeF.
        </p>
      </div>

      {error && <FormError>{error}</FormError>}

      {info && (
        <Alert role="status" className="border-amber-500/40">
          <RiAlertLine className="text-amber-700 dark:text-amber-400" />
          <AlertDescription className="space-y-2 text-sm/relaxed text-foreground">
            <p>{info}</p>
            {duplicates.length > 0 && (
              <ul className="space-y-1 text-xs">
                {duplicates.slice(0, 3).map((d) => (
                  <li key={d.organizationId} className="flex items-center gap-2">
                    <RiBuilding2Line className="size-3 text-muted-foreground" />
                    <span className="font-medium">{d.name}</span>
                    {d.ksefVerified ? (
                      <span className="inline-flex items-center gap-1 text-primary">
                        <RiShieldCheckLine className="size-3" />
                        KSeF zweryfikowany
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </AlertDescription>
        </Alert>
      )}

      {company && (
        <div className="space-y-5 pt-2">
          <div className="border border-primary/30 bg-card p-4">
            <div className="mb-4 flex items-center gap-2.5 text-primary">
              <RiCheckboxCircleLine className="size-5" />
              <span className="text-sm font-medium">
                Znaleziono w bazie GUS
              </span>
            </div>
            <dl className="grid grid-cols-1 gap-4 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">
                  Nazwa firmy
                </dt>
                <dd className="font-medium mt-1">{company.name}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  Adres siedziby
                </dt>
                <dd className="text-foreground mt-1 leading-relaxed">
                  {company.street} {company.buildingNumber}
                  {company.localNumber ? `/${company.localNumber}` : ''}
                  <br />
                  {company.postalCode} {company.city}
                </dd>
              </div>
            </dl>
          </div>

          <Button
            onClick={handleConfirm}
            disabled={isSubmitting}
            className="w-full"
            size="lg"
          >
            {isSubmitting ? (
              <>
                <RiLoader4Line className="animate-spin" />
                Tworzę nową organizację...
              </>
            ) : (
              <>
                {duplicates.length > 0
                  ? 'Mimo to załóż osobną organizację'
                  : 'Załóż organizację'}
                <RiArrowRightLine />
              </>
            )}
          </Button>

          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setCompany(null);
              setNipInput('');
              setError(null);
              setInfo(null);
              setDuplicates([]);
            }}
            className="w-full text-muted-foreground"
          >
            ← Wpisz inny NIP
          </Button>
        </div>
      )}

      {/* BUG-007: wejście do aplikacji bez NIP-u — organizacja-szkic.
          Widoczne dopóki user nie potwierdził firmy z GUS. */}
      {!company && (
        <div className="border-t pt-5 text-center">
          <Button
            type="button"
            variant="ghost"
            className="text-muted-foreground hover:text-foreground"
            onClick={handleSkip}
            disabled={isSkipping || isSearching}
          >
            {isSkipping ? (
              <>
                <RiLoader4Line className="animate-spin" />
                Otwieram aplikację...
              </>
            ) : (
              'Pomiń — uzupełnię NIP później'
            )}
          </Button>
          <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
            Zobaczysz całą aplikację od środka. Wgranie certyfikatu KSeF
            i&nbsp;wysyłka faktur będą możliwe dopiero po uzupełnieniu NIP-u
            w&nbsp;Ustawieniach.
          </p>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Panel: Mam zaproszenie
// ═══════════════════════════════════════════════════════════════

function AcceptInvitePanel({ initialToken }: { initialToken: string }) {
  const [token, setToken] = useState(initialToken);
  const [error, setError] = useState<string | null>(null);
  const [isPending, start] = useTransition();

  const handleAccept = () => {
    setError(null);
    if (!token.trim()) {
      setError('Wklej token z otrzymanego maila');
      return;
    }
    start(async () => {
      // acceptInvitationAction wykonuje redirect server-side po sukcesie.
      const r = await acceptInvitationAction(token.trim());
      if (!r.success) {
        setError(r.error);
      }
    });
  };

  return (
    <div className="space-y-5">
      <Note>
        Otrzymałeś zaproszenie do organizacji w FaktWay? Wklej token z linku
        z maila albo kliknij link bezpośrednio — ten formularz służy jako
        backup, gdy klient pocztowy zerwał link.
      </Note>

      <div className="flex flex-col gap-2">
        <Label htmlFor="invite-token" className={FIELD_LABEL_CLASS}>
          Token zaproszenia*
        </Label>
        <Input
          id="invite-token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Wklej token z maila"
          className="font-mono"
        />
      </div>

      {error && <FormError>{error}</FormError>}

      <Button
        onClick={handleAccept}
        disabled={isPending || !token.trim()}
        className="w-full"
        size="lg"
      >
        {isPending ? (
          <>
            <RiLoader4Line className="animate-spin" />
            Sprawdzam zaproszenie...
          </>
        ) : (
          <>
            Akceptuję zaproszenie
            <RiArrowRightLine />
          </>
        )}
      </Button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Panel: Poproś o dostęp
// ═══════════════════════════════════════════════════════════════

function RequestJoinPanel() {
  const [nipInput, setNipInput] = useState('');
  const [matches, setMatches] = useState<NipMatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [isSearching, startSearch] = useTransition();
  const [isSending, startSend] = useTransition();
  const [message, setMessage] = useState('');
  const [chosenOrg, setChosenOrg] = useState<NipMatch | null>(null);
  const [sentToOrgId, setSentToOrgId] = useState<string | null>(null);

  const handleSearch = () => {
    setError(null);
    setInfo(null);
    setMatches(null);
    setChosenOrg(null);
    setSentToOrgId(null);
    startSearch(async () => {
      const r = await lookupNipAction(nipInput);
      if (!r.success) {
        setError(r.error);
        return;
      }
      if (r.existingOrgs.length === 0) {
        setInfo(
          'Nie znaleziono organizacji z tym NIP-em w FaktWay. Możesz po prostu założyć ją sam (zakładka „Załóż firmę").',
        );
        return;
      }
      setMatches(r.existingOrgs);
    });
  };

  const handleSend = () => {
    if (!chosenOrg) return;
    setError(null);
    startSend(async () => {
      const r = await requestJoinAction({
        organizationId: chosenOrg.organizationId,
        message,
      });
      if (r.success) {
        setSentToOrgId(chosenOrg.organizationId);
      } else {
        setError(r.error);
      }
    });
  };

  if (sentToOrgId) {
    return (
      <Alert role="status" className="border-primary/30 px-3 py-2.5">
        <RiCheckboxCircleLine className="text-primary" />
        <AlertTitle className="text-sm text-primary">Prośba wysłana</AlertTitle>
        <AlertDescription className="text-sm/relaxed text-foreground">
          Właściciele organizacji <strong>{chosenOrg?.name}</strong> dostaną
          notyfikację. Otrzymasz email kiedy zaakceptują lub odrzucą prośbę.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-5">
      <Note>
        Twoja firma jest już w FaktWay, ale nikt Cię nie zaprosił? Wpisz NIP
        — pokażemy listę organizacji z tym NIP-em i wyślemy prośbę o dostęp do
        wybranej. Prośbę zatwierdza właściciel/admin tej organizacji.
      </Note>

      <div className="flex flex-col gap-2">
        <Label htmlFor="nip-join" className={FIELD_LABEL_CLASS}>
          NIP organizacji*
        </Label>
        <InputGroup className="h-10">
          <InputGroupInput
            id="nip-join"
            value={nipInput}
            onChange={(e) => setNipInput(e.target.value.replace(/\D/g, ''))}
            placeholder="Wpisz 10 cyfr NIP"
            maxLength={10}
            inputMode="numeric"
            disabled={isSearching || matches !== null}
            className="font-mono text-base"
          />
          <InputGroupAddon align="inline-end" className="pr-1.5">
            <Button
              onClick={handleSearch}
              variant="ghost"
              size="icon"
              aria-label="Szukaj organizacji po NIP"
              disabled={
                nipInput.length !== 10 || isSearching || matches !== null
              }
            >
              {isSearching ? (
                <RiLoader4Line className="size-5 animate-spin" />
              ) : (
                <RiSearchLine className="size-5" />
              )}
            </Button>
          </InputGroupAddon>
        </InputGroup>
      </div>

      {error && <FormError>{error}</FormError>}

      {info && (
        <Alert role="status">
          <AlertDescription className="text-sm/relaxed text-foreground">{info}</AlertDescription>
        </Alert>
      )}

      {matches && matches.length > 0 && !chosenOrg && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Wybierz organizację, do której prosisz o dostęp
          </p>
          {matches.map((m) => (
            <button
              type="button"
              key={m.organizationId}
              onClick={() => setChosenOrg(m)}
              className="flex w-full items-center gap-3 border bg-card p-3 text-left transition-colors hover:bg-muted"
            >
              <RiBuilding2Line className="size-5 shrink-0 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{m.name}</p>
                {m.ksefVerified ? (
                  <p className="mt-0.5 inline-flex items-center gap-1 text-xs text-primary">
                    <RiShieldCheckLine className="size-3" />
                    Zweryfikowana w KSeF
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Niezweryfikowana w KSeF
                  </p>
                )}
              </div>
              <RiArrowRightLine className="size-4 text-muted-foreground" />
            </button>
          ))}
        </div>
      )}

      {chosenOrg && (
        <div className="space-y-3">
          <div className="flex items-center gap-3 border bg-card p-3">
            <RiBuilding2Line className="size-5 text-muted-foreground" />
            <div className="flex-1 min-w-0">
              <p className="font-medium truncate">{chosenOrg.name}</p>
              <p className="text-xs text-muted-foreground">
                Wybrana organizacja
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setChosenOrg(null)}
              className="text-muted-foreground"
            >
              zmień
            </Button>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="join-message" className={FIELD_LABEL_CLASS}>
              Wiadomość (opcjonalnie)
            </Label>
            <Textarea
              id="join-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Krótka wiadomość do właściciela — kim jesteś i dlaczego prosisz o dostęp"
              rows={3}
            />
          </div>

          <Button
            onClick={handleSend}
            disabled={isSending}
            className="w-full"
            size="lg"
          >
            {isSending ? (
              <>
                <RiLoader4Line className="animate-spin" />
                Wysyłam prośbę...
              </>
            ) : (
              <>
                Wyślij prośbę o dostęp
                <RiArrowRightLine />
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
