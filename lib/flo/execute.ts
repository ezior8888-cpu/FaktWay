/**
 * Wykonawca propozycji (krok 11 planu agenta FLO).
 *
 * JEDNO MIEJSCE, PRZEZ KTÓRE PRZECHODZI KAŻDE WYKONANIE. Nie ma drugiej
 * drogi: test architektoniczny pilnuje, żeby żadne zadanie w tle nie
 * dosięgło funkcji wychodzącej z pominięciem tej ścieżki.
 *
 * KOLEJNOŚĆ KROKÓW JEST NIENEGOCJOWALNA — każdy z nich zamyka inną klasę
 * awarii i zamiana miejscami otwiera ją z powrotem:
 *
 *   1. świeżość danych   — czy świat nie zmienił się od czasu propozycji
 *   2. atomowe przejęcie — czy to my wykonujemy, a nie drugie kliknięcie
 *   3. zużycie żetonu    — czy zgoda człowieka istnieje i jest ważna
 *   4. wykonawca         — dopiero teraz cokolwiek się dzieje
 *   5. dziennik          — ślad, kto, na co i na jakiej podstawie się zgodził
 *
 * Świeżość PRZED przejęciem, bo nieaktualnej propozycji nie chcemy nawet
 * blokować pod siebie. Przejęcie PRZED zużyciem żetonu, bo inaczej dwa
 * równoległe kliknięcia spaliłyby żeton, zanim ustaliłoby się, kto wykonuje.
 */

import { consumeApproval, FloApprovalError } from '@/lib/flo/approval';
import { isApprovalVersion, parseApprovalInput, proposalApprovalVersion } from './approval-version';
import { floDb, type FloDbClient, type FloProposalRow } from '@/lib/flo/db-types';
import { assertFresh, FloStaleError } from '@/lib/flo/fingerprint';
import { getFloHandler } from '@/lib/flo/handlers';
import { isKindEnabledForTenant } from '@/lib/flo/kind-switch';
import { getGlobalFlagForExecution } from '@/lib/feature-flags/global-flags';
import { recordDecision } from '@/lib/flo/decisions';
import { undoableUntil } from '@/lib/flo/undo';
import { logAuditSystem } from '@/lib/audit/log-system';
import type { AuditAction } from '@/lib/audit/log';
import { isFloProposalKind, type FloApproveInput, type FloApproveResult } from '@/types/flo';

/** Odpowiedź, gdy wykonanie padło po zużyciu żetonu (telefon zamienia ją na zdanie bez Flo, plan D13). */
export const EXECUTION_FAILED_MESSAGE = 'Nie udało mi się tego dokończyć. Zajmujemy się tym.';

export interface ExecuteProposalInput {
  proposalId: string;
  tenantId: string;
  userId: string;
  approvalId: string;
  proposalVersion: string;
  input?: FloApproveInput;
}

/** Stany, z których wolno wystartować wykonanie. */
const CLAIMABLE = ['open', 'approved'] as const;

/**
 * `db` jest wstrzykiwalne wyłącznie po to, żeby dało się przetestować wyścig
 * pięćdziesięciu równoległych kliknięć bez stawiania Postgresa. Produkcyjnie
 * zawsze idzie tu prawdziwy klient.
 */
export async function executeProposal(
  args: ExecuteProposalInput,
  now: Date = new Date(),
  db: FloDbClient = floDb(),
): Promise<FloApproveResult> {
  const { proposalId, tenantId, userId, approvalId } = args;
  if (!tenantId || !userId) {
    return { ok: false, reason: 'blocked', message: 'Brak dostępu do organizacji.' };
  }

  let input: FloApproveInput | undefined;
  if (!isApprovalVersion(args.proposalVersion)) {
    return { ok: false, reason: 'stale', message: 'Odśwież propozycję przed zatwierdzeniem.' };
  }
  try {
    input = parseApprovalInput(args.input);
  } catch {
    return { ok: false, reason: 'blocked', message: 'Sprawdź wprowadzone dane.' };
  }

  const loaded = await db
    .from('flo_proposals')
    .select('*')
    .eq('id', proposalId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (loaded.error) throw new Error(loaded.error.message);

  const proposal = loaded.data;
  if (!proposal) {
    return {
      ok: false,
      reason: 'expired',
      message: 'Tej propozycji już nie ma.',
    };
  }

  // Powtórka po wykonaniu nie jest błędem — człowiek mógł kliknąć drugi raz
  // na starym ekranie. Mówimy „zrobione”, bo to jest prawda.
  if (proposal.status === 'done') {
    return proposalApprovalVersion(proposal) === args.proposalVersion ? { ok: true } : changedVersion();
  }

  if (proposal.status === 'executing') {
    return { ok: false, reason: 'blocked', message: 'Wykonanie tej sprawy nadal trwa. Odśwież za chwilę.' };
  }

  if (!CLAIMABLE.includes(proposal.status as (typeof CLAIMABLE)[number])) {
    return {
      ok: false,
      reason: 'expired',
      message: 'Ta propozycja jest już nieaktualna.',
    };
  }

  if (!Number.isFinite(Date.parse(proposal.expires_at)) || Date.parse(proposal.expires_at) <= now.getTime()) {
    await db
      .from('flo_proposals')
      .update({ status: 'expired', dismissed_reason: 'auto_expired' })
      .eq('id', proposalId)
      .eq('tenant_id', tenantId);
    return {
      ok: false,
      reason: 'expired',
      message: 'Minął termin tej propozycji. Przygotuję ją od nowa.',
    };
  }

  if (!isFloProposalKind(proposal.kind)) {
    return {
      ok: false,
      reason: 'blocked',
      message: 'Nie rozpoznaję tego rodzaju sprawy — zgłosiłem to zespołowi.',
    };
  }

  // Existing cards must stop too when an operator disables FLO.
  try {
    const verdict = await isKindEnabledForTenant(
      proposal.kind,
      tenantId,
      db,
      () => getGlobalFlagForExecution('killFloAgent'),
    );
    if (!verdict.enabled) {
      return { ok: false, reason: 'blocked', message: 'Ta funkcja jest teraz wyłączona.' };
    }
  } catch {
    return { ok: false, reason: 'blocked', message: 'Nie udało się sprawdzić dostępności tej funkcji.' };
  }

  if (proposalApprovalVersion(proposal) !== args.proposalVersion) return changedVersion();

  // ── 1. Świeżość danych ──────────────────────────────────────
  try {
    await assertFresh(proposal, now);
  } catch (e) {
    if (e instanceof FloStaleError) {
      await db
        .from('flo_proposals')
        .update({ status: 'expired', dismissed_reason: 'stale' })
        .eq('id', proposalId)
        .eq('tenant_id', tenantId);
      return { ok: false, reason: 'stale', message: e.changes };
    }
    throw e;
  }

  // ── 2. Atomowe przejęcie ────────────────────────────────────
  //
  // Klucz idempotencji to samo przejście statusu. Pięćdziesiąt równoległych
  // kliknięć wykona ten UPDATE, ale warunek `status IN ('open','approved')`
  // spełni dokładnie jedno — reszta dostanie pustą odpowiedź i odpadnie.
  // Nie potrzeba osobnej tabeli blokad ani zewnętrznego zamka.
  const claimed = await db
    .from('flo_proposals')
    .update({ status: 'executing', approved_at: now.toISOString(), approved_by: userId })
    .eq('id', proposalId)
    .eq('tenant_id', tenantId)
    .eq('fingerprint', proposal.fingerprint)
    .in('status', [...CLAIMABLE])
    .select('*');

  if (claimed.error) throw new Error(claimed.error.message);
  const claimedRow = (claimed.data ?? [])[0];
  if (!claimedRow) {
    // Losing the claim can mean a new payload, not a successful second click.
    const latest = await db.from('flo_proposals').select('*')
      .eq('id', proposalId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (latest.error) {
      return { ok: false, reason: 'blocked', message: 'Nie udało się potwierdzić stanu tej sprawy.' };
    }
    if (!latest.data) {
      return { ok: false, reason: 'expired', message: 'Tej propozycji już nie ma.' };
    }
    if (proposalApprovalVersion(latest.data) !== args.proposalVersion) {
      return { ok: false, reason: 'stale', message: 'Propozycja zmieniła się w międzyczasie. Sprawdź ją ponownie.' };
    }
    if (latest.data.status === 'done') return { ok: true };
    if (latest.data.status === 'executing') {
      return { ok: false, reason: 'blocked', message: 'Wykonanie tej sprawy nadal trwa. Odśwież za chwilę.' };
    }
    return { ok: false, reason: 'blocked', message: 'Stan tej sprawy zmienił się. Sprawdź ją ponownie.' };
  }

  const previousStatus = proposal.status;
  // Content may change without changing the fingerprint of underlying facts.
  // Check the returned, atomically claimed row before consuming the token.
  if (proposalApprovalVersion(claimedRow) !== args.proposalVersion) {
    await release(db, proposalId, tenantId, previousStatus);
    return changedVersion();
  }

  // ── 3. Zużycie żetonu zgody ─────────────────────────────────
  let snapshot: Record<string, unknown>;
  try {
    snapshot = await consumeApproval(approvalId, proposalId, tenantId, userId, args.proposalVersion, input, now, db);
  } catch (e) {
    await release(db, proposalId, tenantId, previousStatus);
    if (e instanceof FloApprovalError) {
      return { ok: false, reason: 'blocked', message: e.message };
    }
    throw e;
  }

  // ── 4. Wykonawca ────────────────────────────────────────────
  const handler = getFloHandler(proposal.kind);
  if (!handler) {
    await release(db, proposalId, tenantId, previousStatus);
    return {
      ok: false,
      reason: 'blocked',
      message: 'Tego jeszcze nie umiem wykonać — dam znać, gdy będę umiał.',
    };
  }

  let result: Awaited<ReturnType<typeof handler>>;
  try {
    result = await handler({
      proposal: claimedRow,
      userId,
      approvalId,
      snapshot,
      input,
    });
  } catch (e) {
    // Wykonanie padło PO zużyciu żetonu. Świadomie nie odtwarzamy żetonu:
    // jeśli funkcja wychodząca zdążyła zadziałać, drugie podejście wysłałoby
    // to samo dwa razy. Człowiek dostaje propozycję do ponownego
    // zatwierdzenia, czyli świadomą decyzję zamiast cichego powtórzenia.
    await release(db, proposalId, tenantId, 'approved');

    const message = e instanceof Error ? e.message : 'nieznany błąd';
    await audit(claimedRow, userId, approvalId, 'flo.proposal.failed', {
      error: message.slice(0, 500),
    });

    return {
      ok: false,
      reason: 'blocked',
      message: EXECUTION_FAILED_MESSAGE,
    };
  }

  // AUD-111: od tej chwili działanie JUŻ się odbyło. Błąd zapisu nie może
  // cofnąć karty do „zatwierdzona” (drugie zatwierdzenie = drugie ponaglenie)
  // ani przejść bez śladu — karta zostaje w „wykonuję”, dziennik ma wpis
  // o wykonaniu, a wołający dostaje błąd.
  //
  // Zapis cofnięcia ląduje w ładunku razem z zamknięciem karty — w jednym
  // zapisie, żeby nie było chwili, w której czynność jest zrobiona, a nie
  // da się jej cofnąć.
  const { error: doneError } = await db
    .from('flo_proposals')
    .update({
      status: 'done',
      executed_at: now.toISOString(),
      ...(result.undo
        ? {
            payload: {
              ...(claimedRow.payload ?? {}),
              undo: result.undo,
              undoableUntil: undoableUntil(result.undo),
            },
          }
        : {}),
    })
    .eq('id', proposalId)
    .eq('tenant_id', tenantId)
    .eq('status', 'executing');

  await audit(claimedRow, userId, approvalId, 'flo.proposal.executed', {
    summary: result.summary,
    ...result.details,
    ...(doneError ? { stateWriteFailed: true } : {}),
  });

  if (doneError) {
    throw new Error(`FLO: działanie wykonane, ale stan propozycji nie zapisany (${doneError.message})`);
  }

  try {
    await recordDecision(proposal.tenant_id, proposal.kind, 'accepted', now, db);
    // Także na poziomie sprawy: przyjęcie zeruje serię odrzuceń i zdejmuje
    // ciszę, więc sprawa, na którą człowiek się w końcu zgodził, przestaje
    // się liczyć do reguły tłumu.
    await recordDecision(proposal.tenant_id, proposal.topic_key, 'accepted', now, db);
  } catch (e) {
    // Statystyka decyzji nie może zmienić wyniku wykonanego działania.
    console.error('[flo/execute] nie zapisano decyzji:', e instanceof Error ? e.message : e);
  }

  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════
// Pomocnicze
// ═══════════════════════════════════════════════════════════════

async function release(
  db: FloDbClient,
  proposalId: string,
  tenantId: string,
  status: string,
): Promise<void> {
  const { error } = await db
    .from('flo_proposals')
    .update({ status: status as FloProposalRow['status'] })
    .eq('id', proposalId)
    .eq('tenant_id', tenantId)
    .eq('status', 'executing');
  if (error) {
    // Propozycja utknie w stanie „executing” i zostanie podniesiona przez
    // strażnika zadań. Lepsze to niż przykrycie pierwotnego błędu drugim.
    console.error('[flo/execute] nie udało się zwolnić propozycji:', error.message);
  }
}

async function audit(
  proposal: FloProposalRow,
  userId: string,
  approvalId: string,
  action: AuditAction,
  metadata: Record<string, unknown>,
): Promise<void> {
  await logAuditSystem({
    tenantId: proposal.tenant_id,
    userId,
    action,
    entityType: 'flo_proposal',
    entityId: proposal.id,
    metadata: {
      ...metadata,
      kind: proposal.kind,
      topicKey: proposal.topic_key,
      approvalId,
      // Tytuł zapisujemy dosłownie: przy reklamacji „ja tego nie klikałem”
      // dziennik ma pokazywać to, co człowiek widział na karcie.
      titleShown: proposal.title,
      actor: 'flo',
    },
  });
}

function changedVersion(): FloApproveResult {
  return { ok: false, reason: 'stale', message: 'Propozycja zmieniła się. Sprawdź ją ponownie przed zatwierdzeniem.' };
}
