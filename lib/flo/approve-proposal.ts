import 'server-only';

import { revalidatePath } from 'next/cache';

import { createApproval } from '@/lib/flo/approval';
import { approvalOperationHash, isApprovalVersion, parseApprovalInput, proposalApprovalVersion } from '@/lib/flo/approval-version';
import { floDb, type FloProposalRow } from '@/lib/flo/db-types';
import { executeProposal } from '@/lib/flo/execute';
// Skutek uboczny: rejestracja wykonawców propozycji. NIE USUWAĆ (opis w `app/actions/flo.ts`).
import '@/lib/flo/functions';
import { approvedReminderDelivery } from '@/lib/reminders/delivery-consent';
import type { UserRole } from '@/lib/supabase/auth-context';
import type { FloApproveInput, FloApproveResult, FloProposalKind } from '@/types/flo';

/**
 * Zatwierdzenie propozycji: żeton zgody, potem wykonanie. Wspólne dla akcji
 * strony (`approveProposal` w `app/actions/flo.ts`, sesja z ciasteczek) i API
 * telefonu (zatwierdzenie przypomnienia o zapłacie, `POST
 * /api/mobile/v1/przypomnienia/{id}/zatwierdz`; plan aplikacji mobilnej 4.3,
 * M10a). Logika przeniesiona z akcji bez zmian.
 *
 * Kolejność jest nienegocjowalna. Żeton musi istnieć PRZED wykonaniem, bo
 * to on jest dowodem zgody — a funkcje wychodzące odmawiają działania bez
 * niego. Migawka zapisuje dokładnie to, co człowiek miał na ekranie:
 * tytuł, treść i dane akcji.
 *
 * Ponowienie: żeton jest jeden na propozycję (`createApproval`), więc drugie
 * zatwierdzenie tej samej propozycji kończy się „Ta sprawa jest już w toku”
 * bez drugiego wykonania; przypomnienie ma do tego zapis zlecenia etapu
 * (`hasReminderDispatch`).
 */

export interface ApprovalActor {
  tenantId: string;
  userId: string;
  role: UserRole;
}

export interface ApprovalOptions {
  /**
   * Tylko ten rodzaj propozycji (telefon zatwierdza tylko przypomnienie o zapłacie;
   * aplikacja nie ma Flo, plan D13). Inny rodzaj odmawia przed żetonem.
   */
  onlyKind?: FloProposalKind;
}

export const APPROVAL_ROLE_REFUSAL = 'Działania FLO zatwierdza właściciel albo administrator firmy.';
export const OTHER_KIND_REFUSAL = 'Tę propozycję zatwierdzisz na faktway.pl.';

export function mayApproveProposal(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

export async function approveFloProposal(
  actor: ApprovalActor,
  id: string,
  expectedVersion: string,
  input?: FloApproveInput,
  options: ApprovalOptions = {},
): Promise<FloApproveResult> {
  const { tenantId, role } = actor;
  const user = { id: actor.userId };
  // AUD-113: zatwierdzenie uruchamia działanie na zewnątrz w imieniu firmy
  // (np. ponaglenie do kontrahenta) — tylko właściciel i administrator.
  if (!mayApproveProposal(role)) {
    return { ok: false, reason: 'blocked', message: APPROVAL_ROLE_REFUSAL };
  }
  if (!isApprovalVersion(expectedVersion)) {
    return { ok: false, reason: 'stale', message: 'Odśwież propozycję i sprawdź ją przed zatwierdzeniem.' };
  }
  try {
    input = parseApprovalInput(input);
  } catch {
    return { ok: false, reason: 'blocked', message: 'Sprawdź wprowadzone dane.' };
  }

  const loaded = await floDb()
    .from('flo_proposals')
    .select('*')
    .eq('id', id)
    // Filtr po organizacji to druga linia obrony obok RLS: klient administracyjny
    // omija polityki, więc przynależność sprawdzamy tu jawnie.
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (loaded.error) throw new Error(loaded.error.message);
  const proposal = loaded.data as FloProposalRow | null;

  if (!proposal) {
    return {
      ok: false,
      reason: 'expired',
      message: 'Tej propozycji już nie ma.',
    };
  }

  if (options.onlyKind && proposal.kind !== options.onlyKind) {
    return { ok: false, reason: 'blocked', message: OTHER_KIND_REFUSAL };
  }

  if (proposalApprovalVersion(proposal) !== expectedVersion) {
    return { ok: false, reason: 'stale', message: 'Propozycja zmieniła się. Sprawdź ją ponownie przed zatwierdzeniem.' };
  }

  if (proposal.kind === 'payment.chase') {
    try {
      if (proposal.payload.preparedBy !== user.id) throw new Error('wrong-previewer');
      approvedReminderDelivery(proposal, input);
    } catch {
      return { ok: false, reason: 'blocked', message: 'Przygotuj nowy podgląd przypomnienia. Zachowaj informację o płatności, która mogła już zostać wykonana.' };
    }
  }

  let approvalId: string;
  try {
    approvalId = await createApproval({
      proposalId: id,
      tenantId,
      userId: user.id,
      snapshot: {
        approvalVersion: 1,
        proposalVersion: expectedVersion,
        operationHash: approvalOperationHash(expectedVersion, input),
        title: proposal.title,
        body: proposal.body,
        kind: proposal.kind,
        payload: proposal.payload,
        // Co klient wpisał albo zaznaczył, klikając.
        input: input ?? null,
        clickedAt: new Date().toISOString(),
      },
    });
  } catch {
    // Żeton już istnieje i jest zużyty — czyli ktoś kliknął przed nami.
    return {
      ok: false,
      reason: 'blocked',
      message: 'Ta sprawa jest już w toku.',
    };
  }

  const result = await executeProposal({
    proposalId: id,
    tenantId,
    userId: user.id,
    approvalId,
    proposalVersion: expectedVersion,
    input,
  });

  revalidatePath('/flo');
  revalidatePath('/dashboard');
  return result;
}
