'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Gavel, Loader2, PackageCheck, Undo2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import {
  gateProblemsText,
  OPERATOR_DUPLICATE_MESSAGES,
  operatorReviewButtons,
  type OperatorRecordable,
} from '@/lib/admin/ksef-operator-policy';
import { DUPLICATE_DECISION_TEXTS, type DuplicateChoice, type DuplicateDecisionView } from '@/lib/ksef/duplicate-decision';
import { cn } from '@/lib/utils';
import type { KsefEnvironment } from '@/types/ksef';

import { operatorDecideDuplicateAction, operatorReleaseOriginalReviewAction } from '../actions';

type DecidableView = Extract<DuplicateDecisionView, { kind: 'decidable' }>;
type ReviewView = Extract<DuplicateDecisionView, { kind: 'review' }>;

interface Props {
  invoiceId: string;
  internalNumber: string | null;
  /** `decidable` — „Zapisz decyzję klienta”; `review` (PR C) — „Zapisz fakturę z KSeF w FaktWay” i „Oddaj decyzję klientowi”. */
  view: DecidableView | ReviewView;
  /**
   * `KSEF_ENV` serwera w chwili odczytu karty (PR C, INV-8): akcja wiąże z nim zapis (inne środowisko → `STALE`).
   * Wysyłane tylko przy powodzie `faktflow-original` (oferta niepusta); powód PR B go nie niesie.
   */
  env?: KsefEnvironment | null;
  /** PR C: suchy przebieg strony w przeglądzie pliku — czy plik da się zapisać jako fakturę K (INV-13). */
  recordable?: OperatorRecordable | null;
  /** Inna akcja operatora w toku. */
  disabled?: boolean;
}

const M = OPERATOR_DUPLICATE_MESSAGES;
const T = DUPLICATE_DECISION_TEXTS;

/** Znaki (punkty kodowe), nie jednostki UTF-16 — jak `length(btrim(p_note)) < 10` w RPC i `OPERATOR_NOTE_MIN_LENGTH` w akcji. */
const noteIsTooShort = (note: string): boolean => [...note.trim()].length < 10;

/** Wybory karty: `record` / `review-record` → tylko „ta sama sprzedaż” (`view.choices` z polityki). */
const choicesOf = (view: DecidableView | ReviewView): readonly DuplicateChoice[] => view.choices ?? ['same_sale', 'other_sale'];

/** Etykiety wyborów klienta według oferty (6.6): zapis K w przeglądzie i oferta `record` mają własne. */
function choiceLabelsOf(offer: DecidableView['offer'] | ReviewView['offer']): Record<DuplicateChoice, string> {
  switch (offer) {
    case 'record':
    case 'review-record':
      return { same_sale: M.choiceRecord, other_sale: M.choiceOther };
    case 'review-pair':
      return { same_sale: M.choiceSameRecord, other_sale: M.choiceOtherRecord };
    default:
      return { same_sale: M.choiceSame, other_sale: M.choiceOther };
  }
}

/** Tekst „Rozumiem skutki” klienta (decyzja 7): zapis oferty `record` ma własny, reszta — PR B. */
function confirmationTextOf(view: DecidableView | ReviewView, choice: DuplicateChoice, k: string, nr: string): string {
  if (view.offer === 'record' || view.offer === 'review-record') return M.confirmRecord(k, nr);
  if (choice === 'other_sale') return M.confirmOther(k, nr);
  return view.markedDifference ? M.confirmSame(k, nr) : M.confirmSameUncomparable(k, nr);
}

/** Tabela porównania KSeF ↔ dokument (wspólna dla obu okien). */
function ComparisonTable({ view }: { view: DecidableView | ReviewView }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead />
          <TableHead>{T.COLUMN_KSEF}</TableHead>
          <TableHead>{T.COLUMN_OURS}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {view.comparison.map((row) => (
          <TableRow key={row.label}>
            <TableCell className="text-muted-foreground">{row.label}</TableCell>
            <TableCell className="font-mono text-xs break-all">{row.ksef ?? '—'}</TableCell>
            <TableCell className="font-mono text-xs break-all">
              {row.ours ?? '—'}
              {row.same === false ? <span className="ml-2 font-sans text-xs font-semibold text-amber-700">{T.DIFFERS}</span> : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Podgląd pliku z oceny bramy (`importGate.preview`): okres, liczba pozycji i sumy — bez archiwum (INV-13). */
function PreviewSummary({ view }: { view: DecidableView | ReviewView }) {
  const preview = view.original?.preview ?? null;
  if (!preview) return null;
  return (
    <p className="text-xs text-muted-foreground">
      plik z KSeF: okres {preview.period} · pozycji {preview.lineCount} · netto {preview.totals.net} · VAT {preview.totals.vat} · brutto {preview.totals.gross}
    </p>
  );
}

/**
 * „Zapisz decyzję klienta” (D-A4-1b-3 PR B, spec §2.6.5) i, w przeglądzie pliku (PR C, spec v3 6.6, T8), „Zapisz fakturę
 * z KSeF w FaktWay” oraz „Oddaj decyzję klientowi (plik nie z FaktWay)”. Operator zapisuje decyzję przekazaną przez
 * klienta — wybór, notatka (kanał, data, osoba) i potwierdzenie „Rozumiem skutki” klienta, gdy polityka go wymaga
 * (decyzja 7). Te same sprawdzenia powtarza akcja serwerowa i RPC; to, co karta pokazała (tryb, oferta, środowisko),
 * wiąże STALE po stronie serwera (INV-8).
 */
export function OperatorDuplicateDecision(props: Props) {
  if (props.view.kind === 'review') return <ReviewActions {...props} view={props.view} />;
  return <DecisionDialog {...props} view={props.view} />;
}

/** Okno zapisu decyzji klienta: oferty `pair` / `record` / `released` i powody PR B (`decidable`) albo zapis K w przeglądzie. */
function DecisionDialog({
  invoiceId,
  internalNumber,
  view,
  env = null,
  disabled = false,
  buttonLabel = M.decideButton,
  buttonDisabledReason = null,
}: {
  invoiceId: string;
  internalNumber: string | null;
  view: DecidableView | ReviewView;
  env?: KsefEnvironment | null;
  disabled?: boolean;
  /** Napis przycisku i stopki okna: „Zapisz decyzję klienta” albo „Zapisz fakturę z KSeF w FaktWay” (przegląd). */
  buttonLabel?: string;
  /** Powód wyłączenia przycisku (przegląd: plik niezapisywalny); `null` — włączony. */
  buttonDisabledReason?: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<DuplicateChoice | null>(null);
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const nr = internalNumber ?? view.invoiceNumber ?? '(bez numeru)';
  const k = view.originalKsefNumber;
  const needsConfirmation = choice !== null && view.needsConfirmation[choice];
  const labels = choiceLabelsOf(view.offer);
  const review = view.kind === 'review';

  const reset = () => {
    setChoice(null);
    setNote('');
    setConfirmed(false);
    setNoteError(null);
  };

  const submit = () => {
    if (!choice) return;
    if (noteIsTooShort(note)) {
      setNoteError(M.noteError);
      return;
    }
    setNoteError(null);
    // PR C (INV-8): przy ofercie (`faktflow-original`) karta wysyła tryb, ofertę i środowisko, które pokazała;
    // powód PR B (9-argumentowe RPC) — dokładnie pięć pól jak dotąd.
    const shown = view.offer
      ? { mode: review ? ('import' as const) : view.mode ?? null, offer: view.offer, env }
      : {};
    start(async () => {
      const result = await operatorDecideDuplicateAction(invoiceId, {
        choice,
        note: note.trim(),
        originalKsefNumber: view.originalKsefNumber,
        originalSha256: view.originalSha256,
        confirmed,
        ...shown,
      });
      if (!result.success) {
        toast.error(result.error);
        router.refresh();
        return;
      }
      toast.success(result.message);
      setOpen(false);
      reset();
      router.refresh();
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <Button
        variant="outline"
        onClick={() => setOpen(true)}
        disabled={disabled || pending || buttonDisabledReason !== null}
        title={buttonDisabledReason ?? undefined}
      >
        {review ? <PackageCheck className="h-4 w-4 mr-2" /> : <Gavel className="h-4 w-4 mr-2" />}
        {buttonLabel}
      </Button>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{M.dialogTitle(nr, k)}</DialogTitle>
          <DialogDescription>{M.lead}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <ComparisonTable view={view} />
          <p className="text-xs text-muted-foreground">
            powód: <span className="font-mono">{view.kind === 'decidable' ? view.reason : 'faktflow-original'}</span>
            {view.offer ? <> · oferta: <span className="font-mono">{view.offer}</span></> : null}
            {view.kind === 'decidable' && view.knownInvoice
              ? ` · dokument w FaktWay z tym numerem KSeF: ${view.knownInvoice.internalNumber ?? 'bez numeru'}`
              : ''}
          </p>
          <PreviewSummary view={view} />
          {review ? (
            <>
              <p className="text-xs text-muted-foreground">problemy oceny pliku: {gateProblemsText(view.problems)}</p>
              <p className="text-xs text-muted-foreground">{M.reviewRecordHint}</p>
            </>
          ) : null}

          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={buttonLabel}>
            {choicesOf(view).map((c) => (
              <Button
                key={c}
                type="button"
                role="radio"
                aria-checked={choice === c}
                variant={choice === c ? 'default' : 'outline'}
                onClick={() => {
                  setChoice(c);
                  setConfirmed(false);
                }}
                disabled={pending}
              >
                {labels[c]}
              </Button>
            ))}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="operator-duplicate-note">{M.noteLabel}</Label>
            <Textarea
              id="operator-duplicate-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={M.notePlaceholder}
              maxLength={1000}
              aria-invalid={noteError ? true : undefined}
              disabled={pending}
            />
            {noteError ? <p className="text-xs text-red-600">{noteError}</p> : null}
            {view.offer ? <p className="text-xs text-muted-foreground">{M.noteStoredHint}</p> : null}
          </div>

          {needsConfirmation && choice ? (
            <div className="flex items-start gap-2">
              <Checkbox
                id="operator-duplicate-confirm"
                checked={confirmed}
                onCheckedChange={(v) => setConfirmed(v === true)}
                disabled={pending}
              />
              <Label htmlFor="operator-duplicate-confirm" className={cn('font-normal leading-snug')}>
                {confirmationTextOf(view, choice, k, nr)}
              </Label>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            onClick={submit}
            disabled={pending || choice === null || (needsConfirmation && !confirmed)}
          >
            {pending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            {buttonLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Przegląd pliku z oznaczeniem FaktWay (widok `review`, I5R): „Zapisz fakturę z KSeF w FaktWay” (okno zapisu, włączone
 * tylko gdy suchy przebieg strony mówi, że plik da się zapisać) i — przy `review-pair` — „Oddaj decyzję klientowi”.
 * Włączenie i powody wyłączenia z `operatorReviewButtons` (jedno źródło prawdy z macierzą wyjść).
 */
function ReviewActions({
  invoiceId,
  internalNumber,
  view,
  env = null,
  recordable = null,
  disabled = false,
}: Props & { view: ReviewView }) {
  const buttons = operatorReviewButtons(view, recordable);
  return (
    <>
      <DecisionDialog
        invoiceId={invoiceId}
        internalNumber={internalNumber}
        view={view}
        env={env}
        disabled={disabled}
        buttonLabel={buttons.record.label}
        buttonDisabledReason={buttons.record.enabled ? null : buttons.record.reason ?? M.notBuildable('brak szczegółów')}
      />
      <ReleaseDialog
        invoiceId={invoiceId}
        internalNumber={internalNumber}
        view={view}
        disabled={disabled}
        buttonLabel={buttons.release.label}
        buttonDisabledReason={buttons.release.enabled ? null : buttons.release.reason ?? M.reviewRecordOnly}
      />
    </>
  );
}

/** „Oddaj decyzję klientowi (plik nie z FaktWay)”: notatka (co sprawdzono w pliku) i oddanie; e-mail do klienta wysyła akcja. */
function ReleaseDialog({
  invoiceId,
  internalNumber,
  view,
  disabled,
  buttonLabel,
  buttonDisabledReason,
}: {
  invoiceId: string;
  internalNumber: string | null;
  view: ReviewView;
  disabled: boolean;
  buttonLabel: string;
  buttonDisabledReason: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const nr = internalNumber ?? view.invoiceNumber ?? '(bez numeru)';
  const reset = () => {
    setNote('');
    setNoteError(null);
  };

  const submit = () => {
    if (noteIsTooShort(note)) {
      setNoteError(M.noteError);
      return;
    }
    setNoteError(null);
    start(async () => {
      const result = await operatorReleaseOriginalReviewAction(invoiceId, {
        originalKsefNumber: view.originalKsefNumber,
        originalSha256: view.originalSha256,
        note: note.trim(),
      });
      if (!result.success) {
        toast.error(result.error);
        router.refresh();
        return;
      }
      toast.success(result.message);
      setOpen(false);
      reset();
      router.refresh();
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <Button
        variant="outline"
        onClick={() => setOpen(true)}
        disabled={disabled || pending || buttonDisabledReason !== null}
        title={buttonDisabledReason ?? undefined}
      >
        <Undo2 className="h-4 w-4 mr-2" />
        {buttonLabel}
      </Button>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{M.dialogTitle(nr, view.originalKsefNumber)}</DialogTitle>
          <DialogDescription>{M.releaseLead}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <ComparisonTable view={view} />
          <PreviewSummary view={view} />
          <p className="text-xs text-muted-foreground">problemy oceny pliku: {gateProblemsText(view.problems)}</p>

          <div className="space-y-1.5">
            <Label htmlFor="operator-release-note">{M.releaseNoteLabel}</Label>
            <Textarea
              id="operator-release-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={1000}
              aria-invalid={noteError ? true : undefined}
              disabled={pending}
            />
            {noteError ? <p className="text-xs text-red-600">{noteError}</p> : null}
            <p className="text-xs text-muted-foreground">{M.noteStoredHint}</p>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={submit} disabled={pending || note.trim() === ''}>
            {pending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            {buttonLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
