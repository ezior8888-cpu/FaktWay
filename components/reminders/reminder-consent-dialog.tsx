'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { prepareReminderAction } from '@/app/actions/reminders';
import { approveProposal } from '@/app/actions/flo';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { FloProposalView } from '@/types/flo';

type PreparedReminder = Extract<Awaited<ReturnType<typeof prepareReminderAction>>, { success: true }>;
export interface ReminderConsentSource {
  invoiceId: string;
  stage?: NonNullable<FloProposalView['reminder']>['stage'];
  recipientEmail?: string;
  sourceProposalId?: string;
  sourceVersion?: string;
}

/** Mount a fresh dialog for each source/version. Preparation never sends mail. */
export function ReminderConsentDialog({ source, onClose, onSent }: {
  source: ReminderConsentSource;
  onClose: () => void;
  onSent: () => void;
}) {
  const id = useId();
  const [recipient, setRecipient] = useState(source.recipientEmail ?? '');
  const [prepared, setPrepared] = useState<PreparedReminder | null>(null);
  const [body, setBody] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  useEffect(() => {
    if (!prepared) return;
    const remaining = Date.parse(prepared.expiresAt) - Date.now();
    const timer = setTimeout(() => setExpired(true), Number.isFinite(remaining) ? Math.max(0, remaining) : 0);
    return () => clearTimeout(timer);
  }, [prepared]);

  async function prepare() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    setPrepared(null); setConfirmed(false); setExpired(false); setBody('');
    try {
      const result = await prepareReminderAction({ ...source, recipientEmail: recipient.trim() || undefined });
      if (!active.current) return;
      if (!result.success) { setError(result.error); return; }
      setPrepared(result); setBody(result.preview.body); setRecipient(result.preview.to);
    } catch {
      if (active.current) setError('Nie udało się przygotować podglądu. Spróbuj ponownie.');
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  async function approve() {
    if (inFlight.current || !prepared || !confirmed || !body.trim()) return;
    if (!Number.isFinite(Date.parse(prepared.expiresAt)) || Date.parse(prepared.expiresAt) <= Date.now()) {
      setExpired(true); return;
    }
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const result = await approveProposal(prepared.proposalId, prepared.approvalVersion, { editedBody: body });
      if (!active.current) return;
      if (result.ok) { onSent(); onClose(); return; }
      setError(result.message);
      // A rejected/changed operation needs another reviewed preview.
      setPrepared(null); setConfirmed(false); setBody('');
    } catch {
      if (active.current) {
        setError('Nie udało się potwierdzić wyniku. Sprawdź stan przypomnienia przed ponowną próbą.');
        setPrepared(null); setConfirmed(false);
      }
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !inFlight.current) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Przygotuj przypomnienie</DialogTitle>
          <DialogDescription>Najpierw sprawdź adres i wiadomość. Wysyłkę zlecisz osobnym przyciskiem po obejrzeniu podglądu.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label htmlFor={id + '-recipient'} className="block font-medium">Adres e-mail odbiorcy</label>
          <input id={id + '-recipient'} type="email" value={recipient} maxLength={320} disabled={busy}
            aria-describedby={id + '-recipient-help'}
            onChange={(event) => {
              setRecipient(event.target.value); setPrepared(null); setConfirmed(false); setBody(''); setError(null);
            }}
            className="w-full rounded-md border bg-background px-3 py-2" />
          <p id={id + '-recipient-help'} className="text-xs text-muted-foreground">Puste pole użyje adresu zapisanego na fakturze. Rzeczywisty odbiorca pojawi się w podglądzie.</p>
          <Button type="button" variant="outline" disabled={busy} onClick={() => void prepare()}>
            {busy && !prepared ? 'Przygotowuję…' : 'Przygotuj podgląd'}
          </Button>
        </div>
        {prepared ? (
          <div className="space-y-4">
            <dl className="space-y-2 rounded-md border p-3">
              <div><dt className="font-medium">Od</dt><dd className="break-all">{prepared.preview.from}</dd></div>
              <div><dt className="font-medium">Do</dt><dd className="break-all">{prepared.preview.to}</dd></div>
              {prepared.preview.replyTo ? <div><dt className="font-medium">Odpowiedź na</dt><dd className="break-all">{prepared.preview.replyTo}</dd></div> : null}
              <div><dt className="font-medium">Temat</dt><dd className="break-words">{prepared.preview.subject}</dd></div>
            </dl>
            <div className="space-y-2">
              <label htmlFor={id + '-body'} className="block font-medium">Treść wiadomości</label>
              <textarea id={id + '-body'} value={body} rows={12} maxLength={20000} disabled={busy}
                onChange={(event) => { setBody(event.target.value); setConfirmed(false); }}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
              <p className="text-xs text-muted-foreground">Możesz poprawić treść. Zatwierdzasz dokładnie tekst widoczny w tym polu.</p>
            </div>
            {prepared.preview.attachment ? (
              <div className="rounded-md border p-3">
                <p className="font-medium">Załącznik PDF</p>
                <a download={prepared.preview.attachment.filename}
                  href={'data:application/pdf;base64,' + prepared.preview.attachment.contentBase64}
                  className="break-all underline underline-offset-4">Pobierz i sprawdź: {prepared.preview.attachment.filename}</a>
              </div>
            ) : <p className="text-xs text-muted-foreground">Bez załączników.</p>}
            {/* Poprawka Bartosza 21.10.2026: zdanie z usuniętej noty „Po terminie” stoi przy zgodzie. */}
            <p className="text-xs text-muted-foreground">Przed zatwierdzeniem sprawdź aktualne saldo faktury — wpłata mogła już wpłynąć.</p>
            <label htmlFor={id + '-confirm'} className="flex items-start gap-2">
              <input id={id + '-confirm'} type="checkbox" checked={confirmed} disabled={busy || expired}
                onChange={(event) => setConfirmed(event.target.checked)} className="mt-1" />
              <span>Sprawdziłem odbiorcę, temat, treść i załączniki. Zatwierdzam tę wiadomość do wysyłki.</span>
            </label>
            {expired ? <p role="status">Podgląd wygasł. Przygotuj go ponownie i sprawdź aktualne dane.</p> : null}
          </div>
        ) : null}
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>Anuluj</Button>
          <Button type="button" disabled={busy || !prepared || !confirmed || expired || !body.trim()}
            onClick={() => void approve()}>{busy && prepared ? 'Zlecam…' : 'Zatwierdź i zleć wysyłkę'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
