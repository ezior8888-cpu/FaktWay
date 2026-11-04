'use client';

import { useId, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { OriginalPreview } from '@/lib/ksef/duplicate-check';
import {
  DUPLICATE_DECISION_TEXTS,
  type DuplicateChoice,
  type DuplicateDecisionView,
} from '@/lib/ksef/duplicate-decision';
import type { KsefEnvironment } from '@/types/ksef';

import { decideKsefDuplicateAction } from './actions-detail';
import { KsefOriginalLines } from './ksef-original-lines';

export type DecidableDuplicateView = Extract<DuplicateDecisionView, { kind: 'decidable' }>;

interface Props {
  invoiceId: string;
  view: DecidableDuplicateView;
  /**
   * PR C (INV-8): środowisko KSeF serwera, które strona pokazała klientowi. Panel odsyła je do akcji
   * razem z trybem i ofertą (`faktflow-original`), a serwer odmawia `STALE`, gdy cokolwiek się zmieniło.
   * Powody PR B go nie niosą.
   */
  env?: KsefEnvironment | null;
}

const T = DUPLICATE_DECISION_TEXTS;
const F = DUPLICATE_DECISION_TEXTS.FAKTFLOW;

const BOTH_CHOICES: readonly DuplicateChoice[] = ['same_sale', 'other_sale'];

/** Skutki wyboru (cztery zdania dialogu, 2.11.B) — warianty known-number tam, gdzie je podano. */
function consequences(choice: DuplicateChoice, view: DecidableDuplicateView, nr: string, nrK: string, y: string | null): string[] {
  const k = view.originalKsefNumber;
  if (choice === 'same_sale') {
    const S = T.DIALOG_SAME;
    return [
      y !== null ? S.LINE_1_KNOWN(nrK, k, y) : S.LINE_1(nrK, k, view.program),
      S.LINE_2(nr),
      y !== null ? S.LINE_3_KNOWN(nr, k, y) : S.LINE_3(k),
      S.LINE_4,
    ];
  }
  const O = T.DIALOG_OTHER;
  return [
    O.LINE_1(nr, k),
    O.LINE_2,
    view.heldCorrections ? O.LINE_3 + O.LINE_3_HELD : O.LINE_3,
    y !== null ? O.LINE_4_KNOWN(k, y) : view.program ? O.LINE_4(k, view.program) : O.LINE_4_UNKNOWN_PROGRAM(k),
  ];
}

/** Dane faktury z KSeF potrzebne zdaniom o zapisie oryginału (PR C): okres JPK, numer faktury, flagi z widoku. */
interface OriginalFacts {
  /** `{okres}` — `preview.period` (MM.RRRR). */
  period: string;
  /** `{nrK}` — numer faktury z KSeF (`summary.number`), inaczej numer dokumentu. */
  nrK: string;
  /** Okres wcześniejszy niż bieżący miesiąc — zdanie `PAST_PERIOD`. */
  pastPeriod: boolean;
  /** Nabywca w KSeF ma inny NIP niż na dokumencie — zdanie `BUYER_DIFFERS`. */
  buyerDiffers: boolean;
  /** Korekty do KSeF wstrzymane (PROD) — dopisek `HELD_CORRECTIONS` do zdań o korekcie. */
  held: string;
  /**
   * Dopisek „korekty K jeszcze nie wystawiamy” po ostatnim zdaniu o korekcie: `CORRECTION_PERSON` (nabywca bez NIP
   * i bez numeru VAT-UE) i/albo `CORRECTION_RATE` (pozycja zw, stawka spoza FaktWay, brak ceny netto) — każde
   * najwyżej raz, osoba przed stawką; pusty, gdy korekta K jest możliwa.
   */
  noCorrection: string;
}

/** `MM.RRRR` z daty `RRRR-MM-DD` — tylko gdy widok nie niesie podglądu (nieosiągalne przy poprawnej bramie). */
function periodFromIssueDate(issueDate: string | null): string {
  const match = issueDate ? /^(\d{4})-(\d{2})-\d{2}$/.exec(issueDate) : null;
  return match ? `${match[2]}.${match[1]}` : '—';
}

/**
 * Skutki wyboru przy zapisie oryginału z FaktWay (PR C, 6.1): oferta `pair` — dwa dialogi (ta sama / inna
 * sprzedaż, oba zapisują fakturę z KSeF); oferta `record` — jeden dialog „zapisz”. Zdania o korekcie niosą
 * dopiski na PROD (`held`) i o braku korekty K (`noCorrection`: nabywca bez NIP, pozycja zw / stawka spoza FaktWay), doklejone raz — do ostatniego zdania o korekcie.
 */
function originalConsequences(
  choice: DuplicateChoice,
  view: DecidableDuplicateView,
  nr: string,
  f: OriginalFacts,
): string[] {
  const k = view.originalKsefNumber;
  const pastPeriod = f.pastPeriod ? [F.PAST_PERIOD(f.period)] : [];
  if (view.offer === 'record') {
    const R = F.DIALOG_RECORD;
    return [
      R.LINE_1(f.nrK, f.period),
      R.LINE_2(nr),
      ...(view.sameContent !== true ? [R.LINE_DIFF(f.nrK) + f.held] : []),
      F.REISSUED + f.held + f.noCorrection,
      ...pastPeriod,
    ];
  }
  if (choice === 'same_sale') {
    const S = F.DIALOG_SAME;
    return [
      S.LINE_1(f.nrK, k, f.period),
      S.LINE_2(nr),
      ...(view.markedDifference || view.sameContent !== true ? [F.DATA_FROM_KSEF(f.nrK) + f.held] : []),
      ...(f.buyerDiffers ? [F.BUYER_DIFFERS(f.nrK) + f.held] : []),
      F.REISSUED + f.held + f.noCorrection,
      ...pastPeriod,
      T.DIALOG_SAME.LINE_4,
    ];
  }
  const O = F.DIALOG_OTHER;
  return [
    O.LINE_1(f.nrK, k, f.period),
    O.LINE_2(nr),
    O.ALREADY_REISSUED,
    O.ZERO(f.nrK) + f.held,
    (f.held ? T.DIALOG_OTHER.LINE_3 + T.DIALOG_OTHER.LINE_3_HELD : T.DIALOG_OTHER.LINE_3) + f.noCorrection,
    ...pastPeriod,
  ];
}

/** Oznaczenia faktury w KSeF (`ANNOTATIONS`) z podglądu pliku; `null` — plik nie ma żadnych. */
function annotationsLine(preview: OriginalPreview): string | null {
  if (preview.annotations.length === 0) return null;
  const labels = preview.annotations.map((annotation) =>
    annotation === 'exemption'
      ? F.ANNOTATION_LABELS.exemption(preview.exemptionBasis ?? 'brak podstawy w pliku')
      : F.ANNOTATION_LABELS[annotation]);
  return F.ANNOTATIONS(labels.join(', '));
}

/**
 * Panel decyzji klienta przy nierozstrzygniętym duplikacie 440 (D-A4-1b-3 PR B,
 * decyzje Bartosza 04.10 i 07.10.2026): tabela „W KSeF / Ten dokument” ze
 * znacznikiem „różni się”, linia treści, przy known-number — dokument Y, dwa
 * przyciski i dialog z czterema skutkami. Przy tarciu (decyzja 7) potwierdzenie
 * wymaga zaznaczenia „Rozumiem skutki: …” (C5) — akcja sprawdza to samo na
 * serwerze. Po wyniku toast i `router.refresh()`, także po błędzie: stan
 * faktury mógł się zmienić (np. decyzja zapisana w drugiej karcie).
 *
 * PR C (00156, decyzje Bartosza 08.10.2026, spec 6.1): przy `faktflow-original`
 * widok niesie ofertę, a panel pokazuje ją tak, jak policzył serwer:
 *   - `pair` (FO-PARA) — dwa przyciski; OBA zapisują fakturę z KSeF w FaktWay
 *     (wstęp pary, „nie ma zapisu”, `LEDGER`, oznaczenia, pozycje);
 *   - `record` (FO-WŁASNA, FO-TA-SAMA-TREŚĆ) — jeden przycisk „Zapisz fakturę
 *     z KSeF w FaktWay”; wstęp wybiera `recordIntro` (własna historia ma
 *     pierwszeństwo przed tą samą treścią);
 *   - `released` (FO-ODDANA) — operator sprawdził plik: wstęp i dialogi PR B
 *     z programem „nieznanym”, bez zapisu faktury (tryb `no-import`).
 * Podgląd pliku (okres, pozycje, oznaczenia) pochodzi z `importGate.preview`
 * na znaczniku — panel nie czyta archiwum (INV-13). Do akcji idą też tryb,
 * oferta i środowisko, które panel pokazał (INV-8, odmowa `STALE`); widoki PR B
 * ich nie niosą.
 *
 * Widok (`duplicateDecisionOptions`) liczy serwer; komponent wysyła z powrotem
 * numer KSeF i SHA-256 oryginału, które pokazał (wiązanie, odmowa STALE).
 */
export function KsefDuplicateDecision({ invoiceId, view, env = null }: Props) {
  const router = useRouter();
  const checkboxId = useId();
  const [choice, setChoice] = useState<DuplicateChoice | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, startTransition] = useTransition();

  // Pola PR C są w kontrakcie opcjonalne (widoki PR B ich nie mają): bez oferty = powód PR B.
  const offer = view.offer ?? null;
  const mode = view.mode ?? null;
  const choices = view.choices ?? BOTH_CHOICES;
  const original = view.original ?? null;
  const preview = original?.preview ?? null;
  const writesOriginal = offer === 'pair' || offer === 'record';
  const recordOnly = offer === 'record';

  const nr = view.invoiceNumber ?? '(bez numeru)';
  const k = view.originalKsefNumber;
  // `{nrK}` = numer faktury z KSeF (`summary.number`), inaczej nasz numer.
  const nrK = view.comparison.find((row) => row.label === T.ROW_LABELS.number)?.ksef ?? nr;
  const y = view.knownInvoice ? view.knownInvoice.internalNumber ?? 'bez numeru' : null;
  const contentLine = view.sameContent === null ? T.NO_OWN_FILE : view.sameContent ? T.CONTENT_SAME : T.CONTENT_DIFFERENT;

  const facts: OriginalFacts = {
    period: preview?.period ?? periodFromIssueDate(view.comparison.find((row) => row.label === T.ROW_LABELS.issueDate)?.ksef ?? null),
    nrK,
    pastPeriod: original?.pastPeriod ?? false,
    buyerDiffers: view.comparison.find((row) => row.label === T.ROW_LABELS.buyerNip)?.same === false,
    held: view.heldCorrections ? F.HELD_CORRECTIONS : '',
    noCorrection: (view.correctionForPerson ? F.CORRECTION_PERSON : '') + (view.correctionForRate ? F.CORRECTION_RATE(nrK) : ''),
  };
  const annotations = writesOriginal && preview ? annotationsLine(preview) : null;
  // Wstęp przy ofercie „tylko zapis”: pole widoku (`recordIntro`); bez niego — jak liczy polityka (5.5).
  const recordIntro = view.recordIntro ?? (view.sameContent === true ? 'same' : 'own');

  const needsConfirmation = choice !== null && view.needsConfirmation[choice];
  const canConfirm = choice !== null && !pending && (!needsConfirmation || confirmed);

  const open = (next: DuplicateChoice) => {
    setConfirmed(false);
    setChoice(next);
  };

  const submit = () => {
    if (!choice || !canConfirm) return;
    const picked = choice;
    startTransition(async () => {
      const result = await decideKsefDuplicateAction({
        invoiceId,
        choice: picked,
        originalKsefNumber: view.originalKsefNumber,
        originalSha256: view.originalSha256,
        confirmed,
        // PR C (INV-8): tryb, oferta i środowisko tylko przy ofercie `faktflow-original`; widoki PR B — pięć pól jak dotąd.
        ...(offer !== null ? { mode, offer, env } : {}),
      });
      if (result.success) toast.success(result.message);
      else toast.error(result.error);
      setChoice(null);
      // Sukces: szkic wycofany (baner). Błąd: dane albo stan mogły się zmienić — serwer policzy widok od nowa.
      router.refresh();
    });
  };

  // Dialog: zapis oryginału (`pair` — ta sama / inna sprzedaż, `record` — zapisz) albo PR B (też `released`, program „nieznany”).
  const dialog = recordOnly
    ? { title: F.DIALOG_RECORD.TITLE(nrK), confirm: F.DIALOG_RECORD.CONFIRM_BUTTON }
    : choice === 'same_sale'
      ? { title: T.DIALOG_SAME.TITLE, confirm: T.DIALOG_SAME.CONFIRM_BUTTON }
      : { title: T.DIALOG_OTHER.TITLE, confirm: T.DIALOG_OTHER.CONFIRM_BUTTON };
  // „Ta sama sprzedaż”: „mimo różnic zaznaczonych w tabeli” tylko, gdy tabela którąś zaznacza;
  // tarcie z danych nieznanych (B2C bez NIP, waluta nieznana) — wariant „nie da się porównać”.
  const checkboxLabel = recordOnly
    ? F.DIALOG_RECORD.CHECKBOX(k, nr)
    : choice === 'same_sale'
      ? (view.markedDifference ? T.DIALOG_SAME.CHECKBOX(k, nr) : T.DIALOG_SAME.CHECKBOX_UNCOMPARABLE(k, nr))
      : T.DIALOG_OTHER.CHECKBOX(k, nr);
  const dialogLines = choice === null
    ? []
    : writesOriginal
      ? originalConsequences(choice, view, nr, facts)
      : consequences(choice, view, nr, nrK, y);

  return (
    <div className="mt-3 space-y-3 text-sm text-amber-950">
      {offer === 'pair' && (
        <>
          <p>{F.INTRO_PAIR(nr, k)}</p>
          <p>{F.NOT_RECORDED}</p>
          <p>{F.LEDGER(k, facts.period)}</p>
        </>
      )}
      {recordOnly && (
        <>
          <p>
            {recordIntro === 'own'
              ? F.INTRO_RECORD_OWN(nr, k, original?.assignedDay ?? null, nrK) + facts.noCorrection
              : F.INTRO_RECORD_SAME(nr, k, original?.assignedDay ?? null)}
          </p>
          <p>{F.LEDGER(k, facts.period)}</p>
        </>
      )}
      {!writesOriginal && (
        <>
          <p>{T.INTRO(nr, k, view.program)}</p>
          {offer === 'released' && <p>{F.RELEASED_NOTE}</p>}
        </>
      )}

      <Table className="bg-white/60 rounded-md">
        <TableHeader>
          <TableRow>
            <TableHead className="w-40" />
            <TableHead>{T.COLUMN_KSEF}</TableHead>
            <TableHead>{T.COLUMN_OURS}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {view.comparison.map((row) => (
            <TableRow key={row.label}>
              <TableCell className="font-medium align-top whitespace-normal">
                {row.label}
                {row.same === false && (
                  <span className="ml-2 inline-block rounded bg-amber-200 px-1.5 py-0.5 text-xs font-semibold text-amber-900">
                    {T.DIFFERS}
                  </span>
                )}
              </TableCell>
              <TableCell className="align-top whitespace-normal break-all">{row.ksef ?? '—'}</TableCell>
              <TableCell className="align-top whitespace-normal break-all">{row.ours ?? '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/* Przy ofercie „tylko zapis” wstęp mówi już, czym jest plik (własna wersja / ta sama treść) — linii treści nie ma. */}
      {!recordOnly && <p>{contentLine}</p>}

      {annotations && <p>{annotations}</p>}
      {writesOriginal && preview && <KsefOriginalLines preview={preview} />}

      {view.knownInvoice && y !== null && (
        <p>
          {T.KNOWN_NUMBER_LINE(k, y, nr)}{' '}
          <Link
            href={`/invoices/${encodeURIComponent(view.knownInvoice.id)}`}
            className="font-medium underline underline-offset-2 hover:no-underline"
          >
            {T.KNOWN_LINK(y)}
          </Link>
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {recordOnly ? (
          <Button type="button" variant="outline" onClick={() => open('same_sale')} disabled={pending}>
            {F.BUTTON_RECORD}
          </Button>
        ) : (
          <>
            {choices.includes('same_sale') && (
              <Button type="button" variant="outline" onClick={() => open('same_sale')} disabled={pending}>
                {T.BUTTON_SAME}
              </Button>
            )}
            {choices.includes('other_sale') && (
              <Button type="button" variant="outline" onClick={() => open('other_sale')} disabled={pending}>
                {T.BUTTON_OTHER}
              </Button>
            )}
          </>
        )}
      </div>

      <p className="text-xs text-amber-900">{T.SUPPORT(nr)}</p>

      <Dialog
        open={choice !== null}
        onOpenChange={(isOpen) => {
          // W trakcie zapisu dialog zostaje — wynik zamknie go sam.
          if (!isOpen && !pending) setChoice(null);
        }}
      >
        {/* Skutki są listą pod tytułem — bez osobnego opisu (Base UI: brak opisu nie wymaga aria-describedby). */}
        <DialogContent className="sm:max-w-lg" aria-describedby={undefined}>
          {choice !== null && (
            <>
              <DialogHeader>
                <DialogTitle>{dialog.title}</DialogTitle>
              </DialogHeader>
              <ol className="list-decimal space-y-2 pl-5 text-sm">
                {dialogLines.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ol>
              {needsConfirmation && (
                <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3">
                  <Checkbox
                    id={checkboxId}
                    checked={confirmed}
                    onCheckedChange={(value) => setConfirmed(value === true)}
                    disabled={pending}
                    className="mt-0.5"
                  />
                  <Label htmlFor={checkboxId} className="leading-snug font-normal">
                    {checkboxLabel}
                  </Label>
                </div>
              )}
              <DialogFooter>
                <Button type="button" onClick={submit} disabled={!canConfirm}>
                  {pending && <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden />}
                  {dialog.confirm}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
