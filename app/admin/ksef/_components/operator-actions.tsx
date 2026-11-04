'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { BellRing, Gavel, Loader2, RotateCcw, SearchCheck, Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  OPERATOR_DUPLICATE_MESSAGES,
  operatorInvoiceButtons,
  type OperatorButtonsInput,
} from '@/lib/admin/ksef-operator-policy';
import type { KsefEnvironment } from '@/types/ksef';

import { operatorRemindDuplicateDecisionAction, operatorRequeueAction, operatorResetAction } from '../actions';
import { OperatorDuplicateDecision } from './operator-duplicate-decision';

interface Props extends OperatorButtonsInput {
  invoiceId: string;
  internalNumber: string | null;
  /** PR C (INV-8): `KSEF_ENV` serwera w chwili odczytu karty — okno decyzji wysyła je razem z trybem i ofertą. */
  environment?: KsefEnvironment | null;
}

const BUTTON_LABELS = {
  requeue: 'Wyślij ponownie',
  reconcile: 'Tylko uzgodnij',
  reset: 'Wróć do szkicu',
  decide: OPERATOR_DUPLICATE_MESSAGES.decideButton,
  remind: OPERATOR_DUPLICATE_MESSAGES.remindButton,
  record: OPERATOR_DUPLICATE_MESSAGES.recordButton,
  release: OPERATOR_DUPLICATE_MESSAGES.releaseButton,
} as const;

/**
 * Przyciski operatora: te same RPC co u klienta, z aktorem = operator (PR 3c).
 * D-A4-1b-3 PR B: „Zapisz decyzję klienta” i „Przypomnij klientowi” przy
 * nierozstrzygniętym 440 (widok polityki w `duplicateDecision`).
 * PR C: w przeglądzie pliku z oznaczeniem FaktWay (widok `review`) w miejsce „Zapisz decyzję klienta” — „Zapisz
 * fakturę z KSeF w FaktWay” i „Oddaj decyzję klientowi” (`OperatorDuplicateDecision`).
 */
export function OperatorActions(props: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const buttons = operatorInvoiceButtons(props);
  const label = props.internalNumber ?? props.invoiceId;

  const run = (confirmText: string, fn: () => Promise<{ success: true; message: string } | { success: false; error: string }>) => {
    if (!window.confirm(confirmText)) return;
    start(async () => {
      const result = await fn();
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(result.message);
      router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => run(`Wysłać ponownie fakturę ${label}? Worker zacznie od uzgodnienia po referencji.`, () =>
            operatorRequeueAction(props.invoiceId, { reconcileOnly: false }))}
          disabled={pending || !buttons.requeue.enabled}
          title={buttons.requeue.reason ?? undefined}
        >
          {pending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
          Wyślij ponownie
        </Button>
        <Button
          variant="outline"
          onClick={() => run(`Tylko uzgodnić fakturę ${label} po numerze referencyjnym (bez nowej wysyłki)?`, () =>
            operatorRequeueAction(props.invoiceId, { reconcileOnly: true }))}
          disabled={pending || !buttons.reconcile.enabled}
          title={buttons.reconcile.reason ?? undefined}
        >
          <SearchCheck className="h-4 w-4 mr-2" />
          Tylko uzgodnij
        </Button>
        <Button
          variant="outline"
          onClick={() => run(`Przywrócić fakturę ${label} do szkicu? Dane wysyłki zostaną wyczyszczone (poprzednie wartości trafią do audytu).`, () =>
            operatorResetAction(props.invoiceId))}
          disabled={pending || !buttons.reset.enabled}
          title={buttons.reset.reason ?? undefined}
        >
          <RotateCcw className="h-4 w-4 mr-2" />
          Wróć do szkicu
        </Button>
        {props.duplicateDecision?.kind === 'review' ? (
          <OperatorDuplicateDecision
            invoiceId={props.invoiceId}
            internalNumber={props.internalNumber}
            view={props.duplicateDecision}
            env={props.environment ?? null}
            recordable={props.originalRecordable ?? null}
            disabled={pending}
          />
        ) : buttons.decide.enabled && props.duplicateDecision?.kind === 'decidable' ? (
          <OperatorDuplicateDecision
            invoiceId={props.invoiceId}
            internalNumber={props.internalNumber}
            view={props.duplicateDecision}
            env={props.environment ?? null}
            disabled={pending}
          />
        ) : (
          <Button variant="outline" disabled title={buttons.decide.reason ?? undefined}>
            <Gavel className="h-4 w-4 mr-2" />
            {OPERATOR_DUPLICATE_MESSAGES.decideButton}
          </Button>
        )}
        <Button
          variant="outline"
          onClick={() => run(OPERATOR_DUPLICATE_MESSAGES.remindConfirm(label), () =>
            operatorRemindDuplicateDecisionAction(props.invoiceId))}
          disabled={pending || !buttons.remind.enabled}
          title={buttons.remind.reason ?? undefined}
        >
          <BellRing className="h-4 w-4 mr-2" />
          {OPERATOR_DUPLICATE_MESSAGES.remindButton}
        </Button>
      </div>
      <ul className="space-y-1 text-xs text-muted-foreground">
        {(['requeue', 'reconcile', 'reset', 'decide', 'remind', 'record', 'release'] as const)
          .filter((key) => buttons[key].reason)
          .map((key) => (
            <li key={key}>
              <span className="font-medium">{BUTTON_LABELS[key]}</span>
              {': '}
              {buttons[key].reason}
            </li>
          ))}
      </ul>
    </div>
  );
}
