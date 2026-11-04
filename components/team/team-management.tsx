'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  RiCheckLine,
  RiCloseLine,
  RiMailLine,
  RiMoreLine,
  RiSendPlaneLine,
  RiShieldUserLine,
  RiTimeLine,
  RiVipCrownLine,
} from '@remixicon/react';
import { toast } from 'sonner';

import {
  approveJoinRequestAction,
  changeMembershipRoleAction,
  denyJoinRequestAction,
  inviteMemberAction,
  revokeInvitationAction,
  revokeMembershipAction,
} from '@/app/actions/organizations';
import { MfaStepUpNotice } from '@/components/auth/mfa-step-up-notice';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { formatSettingsDate } from '@/components/settings/finora/format-date';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

import type {
  PendingInvitation,
  PendingJoinRequest,
  TeamMember,
} from '@/app/(dashboard)/settings/team/page';

/**
 * Zespół firmy. Wygląd z Finory: zaproszenie jak wiersz `general/index.tsx`
 * (pole i wybór roli), członkowie, zaproszenia i prośby jak wiersze
 * `security/sessions-card.tsx` (ramka `border p-3`, ikona w `bg-muted`),
 * zmiana roli w `DropdownMenu` jak `connected-institution-row.tsx`. Logika
 * i akcje bez zmian.
 */

type Role = 'owner' | 'admin' | 'member' | 'accountant';

const ROLE_LABEL: Record<string, string> = {
  owner: 'właściciel',
  admin: 'admin',
  member: 'członek',
  accountant: 'księgowy',
};

const ROLE_OPTIONS: Array<{ value: 'admin' | 'member' | 'accountant'; label: string }> = [
  { value: 'member', label: 'członek' },
  { value: 'admin', label: 'admin' },
  { value: 'accountant', label: 'księgowy' },
];

const plDate = formatSettingsDate;

export function TeamManagement({
  members,
  invitations,
  joinRequests,
  currentRole,
}: {
  members: TeamMember[];
  invitations: PendingInvitation[];
  joinRequests: PendingJoinRequest[];
  currentRole: Role;
}) {
  const router = useRouter();
  const isOwner = currentRole === 'owner';
  // Odmowa „potrzebny kod” (sesja po biometrii): komunikat z przejściem na ekran
  // kodu zamiast samego powiadomienia, bo bez wyjścia to ślepy zaułek.
  const [stepUp, setStepUp] = useState<string | null>(null);
  const refresh = () => {
    setStepUp(null);
    router.refresh();
  };

  return (
    <FieldGroup>
      {stepUp ? (
        <MfaStepUpNotice returnTo="/settings/team">
          {stepUp} Po potwierdzeniu wrócisz tutaj.
        </MfaStepUpNotice>
      ) : null}

      <InviteForm onInvited={refresh} onStepUp={setStepUp} />

      {joinRequests.length > 0 && (
        <>
          <Separator />
          <Section title={`Prośby o dostęp (${joinRequests.length})`}>
            {joinRequests.map((r) => (
              <JoinRequestRow
                key={r.id}
                row={r}
                onChanged={refresh}
                onStepUp={setStepUp}
              />
            ))}
          </Section>
        </>
      )}

      {invitations.length > 0 && (
        <>
          <Separator />
          <Section title={`Zaproszenia oczekujące (${invitations.length})`}>
            {invitations.map((i) => (
              <InvitationRow
                key={i.id}
                row={i}
                onChanged={refresh}
              />
            ))}
          </Section>
        </>
      )}

      <Separator />

      <Section
        title={`Członkowie (${members.length})`}
        description="Zarządzaj członkami organizacji, zaproszeniami i prośbami o dostęp."
      >
        {members.map((m) => (
          <MemberRow
            key={m.membershipId}
            member={m}
            isOwner={isOwner}
            onChanged={refresh}
            onStepUp={setStepUp}
          />
        ))}
      </Section>
    </FieldGroup>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <FieldLabel>{title}</FieldLabel>
        {description ? <FieldDescription>{description}</FieldDescription> : null}
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

function RowIcon({ children }: { children: React.ReactNode }) {
  return (
    <Avatar className="size-10 items-center justify-center">
      <AvatarFallback className="bg-muted">{children}</AvatarFallback>
    </Avatar>
  );
}

function InviteForm({ onInvited, onStepUp }: { onInvited: () => void; onStepUp: (message: string) => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member' | 'accountant'>('member');
  const [isPending, start] = useTransition();

  const submit = () => {
    if (!email.trim()) {
      toast.error('Wpisz email');
      return;
    }
    start(async () => {
      const r = await inviteMemberAction({ email: email.trim(), role });
      if (r.success) {
        toast.success('Zaproszenie wysłane');
        setEmail('');
        onInvited();
      } else if (r.mfaStepUp) {
        onStepUp(r.error);
      } else {
        toast.error(r.error);
      }
    });
  };

  return (
    <Field orientation="responsive" className="flex-col!">
      <FieldContent>
        <FieldLabel htmlFor="invite-email">Zaproś nowego członka</FieldLabel>
        <FieldDescription>
          Wyślemy mailem link z tokenem ważnym 7 dni. Zaproszenie weryfikuje
          adres email — sam token w odpowiednim koncie nie wystarcza.
        </FieldDescription>
      </FieldContent>
      <div className="grid w-full! grid-cols-1 gap-3 sm:grid-cols-[1fr_10rem_auto]">
        <Input
          id="invite-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="adres@example.pl"
          disabled={isPending}
        />
        <Select
          items={ROLE_OPTIONS}
          value={role}
          disabled={isPending}
          onValueChange={(value) => value && setRole(value as 'admin' | 'member' | 'accountant')}
        >
          <SelectTrigger className="w-full" aria-label="Rola">
            <SelectValue placeholder="Rola" />
          </SelectTrigger>
          <SelectContent className="p-1" alignItemWithTrigger={false}>
            <SelectGroup>
              {ROLE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button onClick={submit} disabled={isPending || !email.trim()}>
          <RiSendPlaneLine aria-hidden />
          Wyślij
        </Button>
      </div>
    </Field>
  );
}

function MemberRow({
  member,
  isOwner,
  onChanged,
  onStepUp,
}: {
  member: TeamMember;
  isOwner: boolean;
  onChanged: () => void;
  onStepUp: (message: string) => void;
}) {
  const [isPending, start] = useTransition();

  const handleChangeRole = (newRole: Role) => {
    start(async () => {
      const r = await changeMembershipRoleAction({
        membershipId: member.membershipId,
        newRole,
      });
      if (r.success) {
        toast.success('Rola zmieniona');
        onChanged();
      } else if (r.mfaStepUp) {
        onStepUp(r.error);
      } else {
        toast.error(r.error);
      }
    });
  };

  const handleRevoke = () => {
    if (
      !window.confirm(
        member.isYou
          ? 'Na pewno chcesz opuścić tę organizację?'
          : `Wyrzucić użytkownika ${member.email || member.name} z organizacji?`,
      )
    ) {
      return;
    }
    start(async () => {
      const r = await revokeMembershipAction(member.membershipId);
      if (r.success) {
        toast.success('Membership cofnięty');
        onChanged();
      } else {
        toast.error(r.error);
      }
    });
  };

  const canChangeRole = isOwner && member.role !== 'owner';

  return (
    <div className="flex items-center justify-between gap-3 border p-3">
      <div className="flex min-w-0 items-center gap-3">
        <RowIcon>
          {member.role === 'owner' ? (
            <RiVipCrownLine className="size-5 text-amber-600 dark:text-amber-400" />
          ) : (
            <RiShieldUserLine className="text-muted-foreground size-5" />
          )}
        </RowIcon>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium" title={member.name}>
              {member.name}
            </p>
            {member.isYou ? (
              <Badge className="bg-green-600/10 text-green-600 dark:bg-green-400/10 dark:text-green-400">Ty</Badge>
            ) : null}
          </div>
          <p className="text-muted-foreground truncate text-xs">
            {member.email || '(brak emaila)'} · {ROLE_LABEL[member.role]}
          </p>
          <p className="text-muted-foreground text-xs">dołączył(a) {plDate(member.joinedAt)}</p>
        </div>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon" aria-label="Akcje członka" disabled={isPending} />}
        >
          <RiMoreLine />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="p-1">
          {canChangeRole ? (
            <>
              {ROLE_OPTIONS.map((o) => (
                <DropdownMenuItem
                  key={o.value}
                  onClick={() => handleChangeRole(o.value)}
                  className={cn(o.value === member.role && 'bg-muted')}
                >
                  {o.label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem
                onClick={() => handleChangeRole('owner')}
                className="text-amber-600 dark:text-amber-400"
              >
                właściciel
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem variant="destructive" onClick={handleRevoke}>
            {member.isYou ? 'Opuść' : 'Usuń'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function InvitationRow({
  row,
  onChanged,
}: {
  row: PendingInvitation;
  onChanged: () => void;
}) {
  const [isPending, start] = useTransition();
  const handleRevoke = () => {
    start(async () => {
      const r = await revokeInvitationAction(row.id);
      if (r.success) {
        toast.success('Zaproszenie cofnięte');
        onChanged();
      } else {
        toast.error(r.error);
      }
    });
  };

  return (
    <div className="flex items-center justify-between gap-3 border p-3">
      <div className="flex min-w-0 items-center gap-3">
        <RowIcon>
          <RiMailLine className="text-muted-foreground size-5" />
        </RowIcon>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium" title={row.email}>
            {row.email}
          </p>
          <p className="text-muted-foreground text-xs">
            rola {ROLE_LABEL[row.role] ?? row.role} · wygasa {plDate(row.expiresAt)}
          </p>
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        onClick={handleRevoke}
        disabled={isPending}
        aria-label={`Cofnij zaproszenie dla ${row.email}`}
      >
        <RiCloseLine />
      </Button>
    </div>
  );
}

function JoinRequestRow({
  row,
  onChanged,
  onStepUp,
}: {
  row: PendingJoinRequest;
  onChanged: () => void;
  onStepUp: (message: string) => void;
}) {
  const [isPending, start] = useTransition();

  const handleApprove = (approve: boolean) => {
    start(async () => {
      const r = approve
        ? await approveJoinRequestAction(row.id, 'member')
        : await denyJoinRequestAction(row.id);
      if (r.success) {
        toast.success(approve ? 'Dodano do zespołu' : 'Prośba odrzucona');
        onChanged();
      } else if (r.mfaStepUp) {
        onStepUp(r.error);
      } else {
        toast.error(r.error);
      }
    });
  };

  return (
    <div className="flex flex-col gap-3 border p-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <RowIcon>
          <RiTimeLine className="text-muted-foreground size-5" />
        </RowIcon>
        <div className="flex min-w-0 flex-col gap-1">
          <p className="truncate text-sm font-medium">
            {row.name}{' '}
            <span className="text-muted-foreground text-xs font-normal">({row.email})</span>
          </p>
          <p className="text-muted-foreground text-xs">Złożono {plDate(row.createdAt)}</p>
          {row.message ? <p className="bg-muted mt-1 p-3 text-sm leading-relaxed">{row.message}</p> : null}
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" onClick={() => handleApprove(true)} disabled={isPending}>
          <RiCheckLine aria-hidden />
          Akceptuj
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => handleApprove(false)}
          disabled={isPending}
          aria-label={`Odrzuć prośbę ${row.email}`}
        >
          <RiCloseLine />
        </Button>
      </div>
    </div>
  );
}
