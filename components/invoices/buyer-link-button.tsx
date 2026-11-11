'use client';

import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { RiFileCopyLine, RiLinkM, RiLinkUnlinkM, RiLoader4Line } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { formatTimestampDatePl } from '@/lib/format/iso-date';
import { formatWarsawDateTime } from '@/lib/format/warsaw-date';
import { plural } from '@/lib/i18n/plural';
import { BUYER_LINK_TTL_DAYS, type BuyerLinkState } from '@/lib/invoice-share/policy';
import { createBuyerLinkAction, getBuyerLinkAction, revokeBuyerLinkAction } from './buyer-link-actions';

type Panel =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; link: BuyerLinkState | null };

function openedText(link: BuyerLinkState): string {
  if (link.openCount === 0) return 'Nabywca jeszcze go nie otworzył.';
  const times = `${link.openCount} ${plural(link.openCount, ['raz', 'razy', 'razy'])}`;
  return link.lastOpenedAt
    ? `Otwarty ${times}, ostatnio ${formatWarsawDateTime(link.lastOpenedAt)}.`
    : `Otwarty ${times}.`;
}

/**
 * „Link dla nabywcy” w karcie „Dokument” faktury (krok 2.10, decyzja D1:
 * nowy przycisk z istniejących komponentów, na końcu listy akcji). Arkusz jak
 * „Wyślij e-mailem”: stan ostatniego linku, utworzenie, kopiowanie i cofnięcie.
 * Pełny adres z tokenem jest tylko w odpowiedzi akcji tworzenia: arkusz pokazuje
 * go raz, bo baza trzyma sam skrót.
 */
export function BuyerLinkButton({ invoiceId, className }: { invoiceId: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>({ kind: 'loading' });
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [isPending, start] = useTransition();

  // Każde otwarcie zaczyna od stanu z bazy; adres z poprzedniego otwarcia znika.
  const openSheet = () => {
    setCreatedUrl(null);
    setPanel({ kind: 'loading' });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getBuyerLinkAction(invoiceId)
      .then((result) => {
        if (cancelled) return;
        setPanel(result.success ? { kind: 'ready', link: result.link } : { kind: 'error', message: result.error });
      })
      .catch(() => {
        if (!cancelled) setPanel({ kind: 'error', message: 'Nie udało się sprawdzić linku. Spróbuj ponownie za chwilę.' });
      });
    return () => {
      cancelled = true;
    };
  }, [open, invoiceId]);

  const create = () => {
    start(async () => {
      const result = await createBuyerLinkAction(invoiceId);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      setCreatedUrl(result.url);
      setPanel({ kind: 'ready', link: result.link });
      toast.success('Link gotowy. Skopiuj go i wyślij nabywcy.');
    });
  };

  const revoke = (linkId: string) => {
    start(async () => {
      const result = await revokeBuyerLinkAction(linkId);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      setCreatedUrl(null);
      const refreshed = await getBuyerLinkAction(invoiceId);
      setPanel(refreshed.success ? { kind: 'ready', link: refreshed.link } : { kind: 'ready', link: null });
      toast.success('Link cofnięty. Nabywca już go nie otworzy.');
    });
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link skopiowany.');
    } catch {
      toast.error('Nie udało się skopiować. Zaznacz link w polu i skopiuj go ręcznie.');
    }
  };

  const link = panel.kind === 'ready' ? panel.link : null;
  const active = link?.status === 'active' ? link : null;
  const fieldId = `buyer-link-${invoiceId}`;

  return (
    <>
      <Button variant="outline" className={className} onClick={openSheet}>
        <RiLinkM />
        Link dla nabywcy
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Link dla nabywcy</SheetTitle>
            <SheetDescription>
              Nabywca otworzy fakturę bez logowania: podgląd, numer KSeF, dane do przelewu oraz PDF i plik XML
              z KSeF. Nie zobaczy innych faktur ani innych danych Twojej firmy. Link działa {BUYER_LINK_TTL_DAYS} dni,
              a cofnąć go możesz w każdej chwili.
            </SheetDescription>
          </SheetHeader>

          <div className="flex flex-1 flex-col overflow-y-auto px-4">
            {panel.kind === 'loading' && (
              <p className="text-muted-foreground flex items-center gap-2 text-sm">
                <RiLoader4Line className="size-4 animate-spin" aria-hidden />
                Sprawdzam link do tej faktury.
              </p>
            )}

            {panel.kind === 'error' && <p className="text-destructive text-sm">{panel.message}</p>}

            {panel.kind === 'ready' && (
              <FieldGroup>
                {createdUrl && (
                  <Field>
                    <FieldLabel htmlFor={fieldId}>Link do wysłania nabywcy</FieldLabel>
                    <FieldContent>
                      <Input
                        id={fieldId}
                        readOnly
                        value={createdUrl}
                        onFocus={(event) => event.currentTarget.select()}
                        className="font-mono"
                      />
                      <FieldDescription>
                        Skopiuj link teraz: ze względów bezpieczeństwa FaktWay pokazuje go tylko raz. Później możesz
                        go cofnąć albo utworzyć nowy.
                      </FieldDescription>
                    </FieldContent>
                  </Field>
                )}

                {active && (
                  <div className="space-y-1 text-sm">
                    <p>Link działa do {formatTimestampDatePl(active.expiresAt)}.</p>
                    <p className="text-muted-foreground">{openedText(active)}</p>
                    {!createdUrl && (
                      <p className="text-muted-foreground">
                        Nowy link zastąpi obecny: stary przestanie działać.
                      </p>
                    )}
                  </div>
                )}

                {link?.status === 'expired' && (
                  <p className="text-muted-foreground text-sm">
                    Ostatni link wygasł {formatTimestampDatePl(link.expiresAt)}. Utwórz nowy, jeśli nabywca nadal
                    potrzebuje faktury.
                  </p>
                )}

                {link?.status === 'revoked' && link.revokedAt && (
                  <p className="text-muted-foreground text-sm">
                    Ostatni link cofnięto {formatTimestampDatePl(link.revokedAt)}.
                  </p>
                )}
              </FieldGroup>
            )}
          </div>

          <SheetFooter className="flex-row flex-wrap">
            {createdUrl ? (
              <Button type="button" onClick={() => void copy(createdUrl)} disabled={isPending}>
                <RiFileCopyLine />
                Kopiuj link
              </Button>
            ) : (
              <Button type="button" onClick={create} disabled={isPending || panel.kind !== 'ready'}>
                {isPending ? <RiLoader4Line className="animate-spin" /> : <RiLinkM />}
                {active ? 'Utwórz nowy link' : 'Utwórz link'}
              </Button>
            )}
            {active && (
              <Button type="button" variant="destructive" onClick={() => revoke(active.id)} disabled={isPending}>
                <RiLinkUnlinkM />
                Cofnij link
              </Button>
            )}
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
              Zamknij
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}
