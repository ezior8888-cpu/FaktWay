/**
 * Cykl życia propozycji agenta FLO (krok 7 planu).
 *
 * Propozycja to jedna karta w interfejsie i jednocześnie jedna decyzja do
 * podjęcia przez człowieka. Ten moduł odpowiada za jej powstanie, aktualizację,
 * wygasanie i zamianę na kształt, który rozumie interfejs.
 *
 * TRZY ZASADY WBUDOWANE W TEN PLIK:
 *
 * 1. JEDEN TEMAT = JEDNA KARTA. Nowa wiedza o tej samej sprawie aktualizuje
 *    istniejącą propozycję zamiast tworzyć drugą. Bez tego agent potrafiłby
 *    postawić obok siebie dwie karty mówiące co innego — a to koniec zaufania.
 *
 * 2. PROPOZYCJA MA TERMIN WAŻNOŚCI. Ponaglenie sprzed trzech dni opisuje
 *    świat, którego już nie ma. Po terminie karta znika sama i nie da się jej
 *    wykonać, nawet z zapisanego linku.
 *
 * 3. WYCISZENIE JEST RESPEKTOWANE PRZED ZAPISEM. Sprawdzamy je, zanim
 *    propozycja powstanie, a nie przy wyświetlaniu — inaczej baza puchłaby
 *    od kart, których nikt nigdy nie zobaczy.
 */

import {
  floDb,
  type FloDbClient,
  type FloProposalInsert,
  type FloProposalRow,
} from '@/lib/flo/db-types';
import { proposalApprovalVersion } from '@/lib/flo/approval-version';
import { isSilenced } from '@/lib/flo/decisions';
import { isKindEnabled } from '@/lib/flo/flags';
import { isKindEnabledForTenant, shouldCompute } from '@/lib/flo/kind-switch';
import { FLO_KIND_VARIANT } from '@/lib/flo/kind-variant';
import { recordShadow, shadowSubject } from '@/lib/flo/shadow';
import { isTaxKind, taxGateOpen } from '@/lib/flo/tax-profile';
import {
  isFloProposalKind,
  type FloAction,
  type FloEvidence,
  type FloListItem,
  type FloPreview,
  type FloProposalKind,
  type FloProposalView,
} from '@/types/flo';

// ═══════════════════════════════════════════════════════════════
// Tworzenie i aktualizacja
// ═══════════════════════════════════════════════════════════════

export interface CreateProposalInput {
  tenantId: string;
  kind: FloProposalKind;
  /** kontrahent + rodzaj + okres — klucz deduplikacji */
  topicKey: string;
  title: string;
  body: string;
  fingerprint: string;
  expiresAt: Date;
  priority?: number;
  payload?: Record<string, unknown>;
  evidence?: FloEvidence[];
}

export type CreateProposalResult =
  | { status: 'created'; id: string }
  | { status: 'updated'; id: string }
  | { status: 'muted' }
  /** Funkcja wyłączona globalnie (prawo, niepotwierdzone dane) — patrz flags.ts */
  | { status: 'disabled' }
  /**
   * Grupa podatkowa bez kompletnego profilu albo bez sprawdzonej tabeli
   * parametrów (mechanizm M12) — patrz `lib/flo/tax-profile.ts`.
   */
  | { status: 'no_tax_profile' };

/**
 * Tworzy propozycję albo — gdy żywa propozycja tego samego tematu już
 * istnieje — aktualizuje ją w miejscu.
 *
 * Aktualizacja obejmuje treść, dowody i odcisk danych, ale NIE przywraca
 * karty do stanu „otwarta”, jeśli człowiek zdążył ją zatwierdzić. Zatwierdzona
 * propozycja czeka na wykonanie i nie wolno jej podmienić pod ręką — to byłaby
 * zgoda na jedną treść, a wykonanie innej.
 */
export async function createProposal(
  input: CreateProposalInput,
  db: FloDbClient = floDb(),
  /** Wstrzykiwane tylko w testach — patrz `isKindEnabledForTenant`. */
  readGlobalKill?: () => Promise<boolean>,
): Promise<CreateProposalResult> {
  // Wyłącznik globalny idzie PIERWSZY: funkcja czekająca na opinię prawnika
  // nie ma prawa zostawić śladu w bazie klienta. Inaczej po włączeniu
  // wysypałaby się na niego lawina kart sprzed miesięcy.
  if (!isKindEnabled(input.kind)) {
    return { status: 'disabled' };
  }

  // Warstwy M8 (krok 53): globalny wyłącznik agenta i przełącznik per konto.
  // Sprawdzane PRZED zapisem — funkcja wyłączona nie ma zostawiać śladu
  // w bazie klienta, bo po ponownym włączeniu wysypałaby się na niego
  // lawina kart sprzed tygodni.
  const verdict = await isKindEnabledForTenant(
    input.kind,
    input.tenantId,
    db,
    readGlobalKill,
  );

  // TRYB CICHY (krok 35 toru B). Konto poza kanarkiem to JEDYNY powód
  // wyłączenia, przy którym agent chciałby mówić i wie dokładnie co —
  // a milczy wyłącznie dlatego, że funkcja nie wyszła jeszcze z ukrycia.
  // Tylko tam da się zmierzyć trafność PRZED odsłonięciem.
  //
  // Pozostałych powodów mierzyć nie wolno: przy blokadzie prawnej nie mamy
  // prawa nawet policzyć, co byśmy powiedzieli, a przy wyłączniku globalnym
  // i wypisaniu konta przez operatora liczylibyśmy decyzję człowieka.
  //
  // To NIE jest złamanie zasady „funkcja wyłączona nie zostawia śladu
  // w bazie klienta". `flo_shadow` jest tabelą operatorską: nie ma treści
  // karty, nie ma danych kontrahenta i żaden jej wiersz nigdy nie stanie
  // się kartą w wątku klienta.
  const shadowOnly = !verdict.enabled && shouldCompute(verdict);

  if (!verdict.enabled && !shadowOnly) {
    return { status: 'disabled' };
  }

  // Bramka M12: bez profilu podatkowego cała grupa T milczy. Warunek stoi
  // tutaj, a nie w pięciu funkcjach podatkowych osobno — inaczej szósta,
  // dopisana za rok, pominęłaby go przez zwykłe przeoczenie.
  if (isTaxKind(input.kind) && !(await taxGateOpen(input.tenantId, db))) {
    return { status: 'no_tax_profile' };
  }

  // Cisza na dwóch poziomach: rodzaj („nigdy więcej takich") i POJEDYNCZA
  // sprawa („nie chcę reguły akurat u Adobe"). Klucz tematu jest tożsamością
  // sprawy, więc wyciszenie jednej faktury nie zabiera pytań o pozostałe.
  const silence = await isSilenced(
    input.tenantId,
    input.kind,
    input.topicKey,
    new Date(),
    db,
  );
  if (silence.silenced) {
    return { status: 'muted' };
  }

  // Wpis trybu cichego powstaje DOPIERO TUTAJ — po bramce podatkowej
  // i po wyciszeniu. Zapis wyżej liczyłby propozycje, których agent i tak
  // by nie postawił, i zawyżałby próbkę bramki gotowości o przypadki,
  // w których prawdziwą odpowiedzią jest milczenie.
  if (shadowOnly) {
    await recordShadow(
      {
        tenantId: input.tenantId,
        kind: input.kind,
        proposal: {
          topicKey: input.topicKey,
          fingerprint: input.fingerprint,
          ...shadowSubject({ kind: input.kind, payload: input.payload }),
        },
      },
      db,
    );
    return { status: 'disabled' };
  }

  const existing = await db
    .from('flo_proposals')
    .select('id, status')
    .eq('tenant_id', input.tenantId)
    .eq('topic_key', input.topicKey)
    .in('status', ['open', 'approved'])
    .maybeSingle();

  if (existing.error) throw new Error(existing.error.message);

  if (existing.data) {
    if (existing.data.status === 'approved') {
      // Zgoda dotyczyła konkretnej treści — nie podmieniamy jej pod ręką.
      return { status: 'updated', id: existing.data.id };
    }

    const patch = await db
      .from('flo_proposals')
      .update({
        title: input.title,
        body: input.body,
        payload: input.payload ?? {},
        evidence: input.evidence ?? [],
        fingerprint: input.fingerprint,
        expires_at: input.expiresAt.toISOString(),
        priority: input.priority ?? 50,
      })
      .eq('id', existing.data.id)
      .eq('tenant_id', input.tenantId)
      .eq('status', 'open');

    if (patch.error) throw new Error(patch.error.message);
    return { status: 'updated', id: existing.data.id };
  }

  const row: FloProposalInsert = {
    tenant_id: input.tenantId,
    kind: input.kind,
    topic_key: input.topicKey,
    title: input.title,
    body: input.body,
    fingerprint: input.fingerprint,
    expires_at: input.expiresAt.toISOString(),
    priority: input.priority ?? 50,
    payload: input.payload ?? {},
    evidence: input.evidence ?? [],
  };

  const inserted = await db
    .from('flo_proposals')
    .insert(row)
    .select('id')
    .maybeSingle();

  if (inserted.error) {
    // 23505 = wyścig: równoległy przebieg zdążył utworzyć tę samą propozycję
    // między naszym SELECT-em a INSERT-em. Unikalny indeks częściowy zadziałał
    // dokładnie tak, jak powinien — to nie jest awaria.
    if (isUniqueViolation(inserted.error)) {
      return { status: 'updated', id: '' };
    }
    throw new Error(inserted.error.message);
  }

  return { status: 'created', id: inserted.data?.id ?? '' };
}

/**
 * Oznacza przeterminowane propozycje. Wołane z crona `flo.tick`.
 *
 * Świadomie nie kasujemy wierszy: wygasła propozycja jest informacją o tym,
 * co agent widział i czego człowiek nie potrzebował. To materiał do pomiaru
 * trafności, a nie śmieć.
 *
 * JEDEN UPDATE Z WARUNKIEM W ZAPYTANIU (FLO-01). Wcześniej najpierw szedł
 * odczyt listy id, a potem ta lista wracała w adresie PATCH-a. Odczyt
 * PostgREST ucina do 1000 wierszy, a adres rósł z każdą kartą: od ok. 200
 * kart przekraczał 8000 znaków, a wyjątek zatrzymywał cały puls. Teraz adres
 * ma stałą długość, karty wybiera i liczy baza (`count: 'exact'`), a warunek
 * na status sprawdza się w chwili zapisu — karta, którą wykonawca właśnie
 * przejął, nie zostanie przestawiona na „wygasła”. Drugi przebieg niczego
 * nie zmienia, bo wygasła karta nie spełnia już warunku.
 */
export async function expireStale(
  now: Date = new Date(),
  db: FloDbClient = floDb(),
): Promise<number> {
  const { error, count } = await db
    .from('flo_proposals')
    .update(
      { status: 'expired', dismissed_reason: 'auto_expired' },
      { count: 'exact' },
    )
    .in('status', ['open', 'approved'])
    .lt('expires_at', now.toISOString());

  if (error) throw new Error(error.message);
  return count ?? 0;
}

// ═══════════════════════════════════════════════════════════════
// Odczyt
// ═══════════════════════════════════════════════════════════════

/**
 * Otwarte propozycje organizacji, w kolejności, w jakiej mają stać w wątku:
 * najpierw priorytet, potem czas. Kolejność wynika z wagi sprawy, nie
 * z momentu powstania — inaczej gratulacje za próg przychodu wypychałyby
 * w górę fakturę odrzuconą przez KSeF.
 */
export async function listOpen(tenantId: string): Promise<FloProposalView[]> {
  const db = floDb();

  const result = await db
    .from('flo_proposals')
    .select('*')
    .eq('tenant_id', tenantId)
    // Internal consent previews stay out of the feed, before pagination.
    .not('topic_key', 'like', 'reminder-preview:%')
    .in('status', ['open', 'approved'])
    .order('priority', { ascending: true })
    .order('created_at', { ascending: false })
    .limit(50);

  if (result.error) throw new Error(result.error.message);

  return (result.data ?? [])
    .map((row) => toProposalView(row))
    .filter((view): view is FloProposalView => view !== null);
}

// ═══════════════════════════════════════════════════════════════
// Wiersz → widok (funkcja czysta, testowalna bez bazy)
// ═══════════════════════════════════════════════════════════════

/**
 * Zamienia wiersz bazy na jedyny kształt, jaki zna interfejs.
 *
 * Zwraca `null` dla wiersza, którego nie da się bezpiecznie wyświetlić —
 * nieznany rodzaj propozycji oznacza, że baza pamięta coś ze starszej wersji
 * kodu. Lepiej pominąć taką kartę niż narysować ją byle jak: cisza jest
 * dopuszczalna, bełkot nie.
 */
export function toProposalView(row: FloProposalRow): FloProposalView | null {
  if (!isFloProposalKind(row.kind)) return null;

  const kind: FloProposalKind = row.kind;
  const variant = FLO_KIND_VARIANT[kind];
  const payload = row.payload ?? {};

  return {
    id: row.id,
    approvalVersion: proposalApprovalVersion(row),
    reminder: kind === 'payment.chase' ? readReminderSource(payload) : undefined,
    kind,
    variant,
    title: row.title,
    body: row.body,
    evidence: readEvidence(row.evidence),
    primary: primaryAction(variant, payload),
    secondary: secondaryActions(variant, payload),
    preview: readPreview(payload),
    items: readItems(payload),
    expiresAt: row.expires_at,
    priority: row.priority,
    createdAt: row.created_at,
    undoableUntil: readString(payload.undoableUntil) ?? undefined,
    ocrCard: kind === 'expense.review' ? readOcrCard(payload) : undefined,
  };
}

/**
 * Czy karta `expense.review` jest wynikiem odczytu zdjęcia — i jakim.
 *
 * Rodzaj dzielą trzy różne karty: koszt odczytany ze zdjęcia (`expenseId`),
 * porażka odczytu (`failed: 1` + `ocrJobId`, `buildOcrFailedProposal`)
 * i zbiorcza karta skrzynki KSeF (bez `expenseId`). Pasek zdjęcia musi je
 * rozróżnić: wcześniej każda karta `expense.*` znaczyła „paragon odczytany”,
 * także ta, która mówi „nie odczytałem tego zdjęcia”.
 */
function readOcrCard(
  payload: Record<string, unknown>,
): FloProposalView['ocrCard'] {
  const ocrJobId = readString(payload.ocrJobId);

  // Porażka bez numeru zadania nie wskaże żadnego zdjęcia — ale nie może
  // też przejść niżej i udawać odczytanego kosztu.
  if (payload.failed === 1) {
    return ocrJobId ? { failed: true, ocrJobId } : undefined;
  }

  if (readString(payload.expenseId)) {
    return ocrJobId ? { failed: false, ocrJobId } : { failed: false };
  }

  return undefined;
}

/**
 * Etykiety pochodzą na razie z ładunku propozycji, a domyślne z wariantu.
 * Krok 14 planu przeniesie je do szablonów w `lib/flo/copy.ts`, a treści
 * napisze tor interfejsu — do tego czasu te napisy są robocze.
 */
function primaryAction(
  variant: FloProposalView['variant'],
  payload: Record<string, unknown>,
): FloAction {
  const label = readString(payload.primaryLabel) ?? defaultPrimaryLabel(variant);

  if (variant === 'input') {
    return {
      label,
      intent: 'input',
      requiresPreview: true,
      inputLabel: readString(payload.inputLabel) ?? 'Uzupełnij dane',
      inputKind: readInputKind(payload.inputKind),
    };
  }

  // Część kart nie ma czego wykonywać — prowadzą człowieka do miejsca,
  // w którym zrobi coś sam (wgra dokument, poprawi dane). Wymuszanie na nich
  // „wykonania" kończyłoby się handlerem, który udaje, że coś zrobił.
  const intent =
    readString(payload.primaryIntent) === 'open'
      ? ('open' as const)
      : variant === 'info'
        ? ('open' as const)
        : ('approve' as const);

  return {
    label,
    intent,
    // Promień rażenia 4: nie da się kliknąć, nie widząc, co poleci.
    requiresPreview: variant === 'preview' ? true : undefined,
  };
}

function defaultPrimaryLabel(variant: FloProposalView['variant']): string {
  switch (variant) {
    case 'info':
      return 'Pokaż';
    case 'preview':
      return 'Pokaż treść';
    case 'list':
      return 'Wyślij zaznaczone';
    case 'choice':
      return 'Tak';
    case 'input':
      return 'Wyślij';
    default:
      return 'Zgadza się';
  }
}

function secondaryActions(
  variant: FloProposalView['variant'],
  payload: Record<string, unknown>,
): FloAction[] {
  const custom = readActions(payload.secondary);
  if (custom) return custom;

  // Karta bez akcji ma tylko „ukryj” — proponowanie „nigdy więcej takich”
  // przy zwykłym meldunku brzmiałoby jak zniechęcanie do własnego produktu.
  if (variant === 'info') {
    return [{ label: 'Ukryj', intent: 'dismiss' }];
  }

  return [
    { label: 'Nie teraz', intent: 'snooze' },
    { label: 'Nigdy więcej takich', intent: 'mute' },
  ];
}

// ═══════════════════════════════════════════════════════════════
// Bezpieczne odczyty z JSONB
// ═══════════════════════════════════════════════════════════════

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readInputKind(value: unknown): 'email' | 'text' | 'amount' {
  return value === 'email' || value === 'amount' ? value : 'text';
}

function readEvidence(value: unknown): FloEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const label = readString(record.label);
    const href = readString(record.href);
    return label && href ? [{ label, href }] : [];
  });
}

function readActions(value: unknown): FloAction[] | null {
  if (!Array.isArray(value)) return null;
  const actions = value.flatMap((entry): FloAction[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const label = readString(record.label);
    const intent = record.intent;
    const valid =
      intent === 'approve' ||
      intent === 'dismiss' ||
      intent === 'snooze' ||
      intent === 'mute' ||
      intent === 'input' ||
      intent === 'open' ||
      intent === 'correct';
    if (!label || !valid) return [];

    // Akcja z polem niesie ze sobą pytanie i rodzaj pola. Zgubione tutaj
    // zamieniały „Częściowo" w pole „Podaj wartość" bez sprawdzania kształtu
    // kwoty — a wtedy do serwera szło cokolwiek.
    if (intent === 'input') {
      const action: FloAction = {
        label,
        intent: 'input',
        inputKind: readInputKind(record.inputKind),
      };
      const inputLabel = readString(record.inputLabel);
      if (inputLabel) action.inputLabel = inputLabel;
      return [action];
    }

    // Zasięg wyciszenia. Zgubiony tutaj zamieniłby „skończyliśmy współpracę
    // z tym klientem" w „nigdy więcej żadnych szkiców faktur".
    if (intent === 'mute' && record.scope === 'subject') {
      return [{ label, intent: 'mute', scope: 'subject' }];
    }

    return [{ label, intent } as FloAction];
  });
  return actions.length > 0 ? actions : null;
}

function readPreview(payload: Record<string, unknown>): FloPreview | undefined {
  const preview = payload.preview;
  if (typeof preview !== 'object' || preview === null) return undefined;
  const record = preview as Record<string, unknown>;

  switch (record.type) {
    case 'invoice':
    case 'message':
    case 'diff':
    case 'file':
      // Kształt buduje ten, kto tworzy propozycję; tutaj pilnujemy tylko,
      // żeby nieznany typ podglądu nie trafił do interfejsu.
      return preview as FloPreview;
    default:
      return undefined;
  }
}

function readItems(payload: Record<string, unknown>): FloListItem[] | undefined {
  const items = payload.items;
  if (!Array.isArray(items)) return undefined;

  const parsed = items.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const id = readString(record.id);
    const label = readString(record.label);
    const amount = readString(record.amount);
    if (!id || !label || !amount) return [];

    const needsPreview = record.needsPreview === true;
    return [
      {
        id,
        label,
        sublabel: readString(record.sublabel) ?? '',
        amount,
        // Pozycja wymagająca podglądu NIE MOŻE być zaznaczona z góry —
        // to jedyna rzecz, która powstrzymuje hurtową wysyłkę pozycji
        // odbiegających od normy.
        preselected: needsPreview ? false : record.preselected === true,
        needsPreview,
      },
    ];
  });

  return parsed.length > 0 ? parsed : undefined;
}

function isUniqueViolation(error: { message: string } & { code?: string }) {
  return (
    error.code === '23505' ||
    error.message.includes('duplicate key value violates unique constraint')
  );
}

function readReminderSource(payload: Record<string, unknown>): FloProposalView['reminder'] {
  const invoiceId = readString(payload.invoiceId);
  const stage = payload.stage;
  if (!invoiceId || (stage !== 'stage_1' && stage !== 'stage_2' && stage !== 'stage_3' && stage !== 'stage_4')) return undefined;
  return { invoiceId, stage };
}
