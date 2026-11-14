'use client';

import { useRef, useState, useTransition } from 'react';
import { RiDeleteBinLine, RiImageAddLine, RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { deleteCompanyLogoAction } from '@/app/actions/company-logo';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field';
import { formatUploadSize, LOGO_FILE_LIMIT_BYTES, LOGO_FILE_LIMIT_LABEL } from '@/lib/upload-limit';
import { postLogoUpload, type CompanyLogoView } from '@/lib/uploads/client';

const REMOVE_FAILED = 'Nie udało się usunąć logo. Sprawdź połączenie i spróbuj ponownie.';

/**
 * Logo na fakturze (plan kompletnej aplikacji, krok 2.2, część 1): podgląd,
 * wgranie, zmiana i usunięcie z potwierdzeniem. Nowa sekcja na końcu
 * zakładki „Firma” z istniejących komponentów (decyzja D1), wiersz Finory
 * jak `CompanyBankAccountForm`: opis po lewej, podgląd i przyciski po prawej.
 *
 * Plik idzie trasą `/api/uploads/logo` (Server Action przyjmuje najwyżej
 * 1 MiB), z polem `tenantId` firmy, dla której strona się wyrenderowała.
 * Typ pliku sprawdza serwer po bajtach; tu tylko szybka odmowa za dużego
 * pliku. Podgląd stoi na białym tle, jak na wydruku.
 */
export function CompanyLogoForm({
  initial,
  canEdit,
  tenantId,
}: {
  initial: CompanyLogoView;
  /** Właściciel i administrator; pozostali widzą podgląd bez możliwości zmiany. */
  canEdit: boolean;
  tenantId: string;
}) {
  const [view, setView] = useState<CompanyLogoView>(initial);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = (file: File) => {
    if (file.size > LOGO_FILE_LIMIT_BYTES) {
      toast.error(`Plik ma ${formatUploadSize(file.size)}, a logo może mieć najwyżej ${LOGO_FILE_LIMIT_LABEL}.`);
      return;
    }
    const form = new FormData();
    form.set('logo', file);
    form.set('tenantId', tenantId);
    startTransition(async () => {
      const result = await postLogoUpload(form);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      setView({ status: 'ok', previewUrl: result.logo.previewUrl, format: result.logo.format });
      toast.success('Logo zapisane');
    });
  };

  const remove = () => {
    startTransition(async () => {
      const result = await deleteCompanyLogoAction().catch(() => ({ success: false as const, error: REMOVE_FAILED }));
      setConfirmOpen(false);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      setView({ status: 'none' });
      toast.success('Logo usunięte');
    });
  };

  const hasLogo = view.status === 'ok' || view.status === 'missing';
  const actionsVisible = canEdit && view.status !== 'unavailable';

  return (
    <Field orientation="responsive">
      <FieldContent>
        <FieldLabel>Logo na fakturze</FieldLabel>
        <FieldDescription id="company-logo-help">
          {`Logo pojawi się w lewym górnym rogu PDF faktur, proform i ofert, także pobranych ponownie starszych dokumentów. Plik PNG albo JPEG, najwyżej ${LOGO_FILE_LIMIT_LABEL}. Na wydruku ma 1,4 cm wysokości. Faktura w KSeF logo nie zawiera.`}
        </FieldDescription>
        {canEdit ? null : <FieldDescription>Zmienić to może właściciel albo administrator firmy.</FieldDescription>}
      </FieldContent>
      <div className="flex w-full flex-col gap-2 sm:w-80">
        <div className="flex h-24 items-center justify-center border bg-white p-3">
          {view.status === 'ok' && view.previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- podpisany URL magazynu, krótki TTL
            <img src={view.previewUrl} alt="Logo firmy" className="max-h-full max-w-full object-contain" />
          ) : (
            <span className="text-center text-xs text-neutral-500">
              {view.status === 'ok' ? 'Logo zapisane. Podgląd pojawi się po odświeżeniu strony.' : 'Brak logo'}
            </span>
          )}
        </div>
        {view.status === 'missing' ? (
          <p role="alert" className="text-destructive text-xs">
            Nie ma pliku logo w magazynie, więc faktury drukują się bez logo. Wgraj logo ponownie albo je usuń.
          </p>
        ) : null}
        {view.status === 'unavailable' ? (
          <p role="alert" className="text-destructive text-xs">
            Nie udało się odczytać logo. Odśwież stronę, a jeśli to nie pomoże, napisz do pomocy FaktWay.
          </p>
        ) : null}
        {actionsVisible ? (
          <>
            <input
              ref={inputRef}
              type="file"
              accept="image/png,image/jpeg"
              className="hidden"
              aria-describedby="company-logo-help"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) upload(file);
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" onClick={() => inputRef.current?.click()} disabled={pending} className="max-lg:min-h-[44px]">
                {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : <RiImageAddLine aria-hidden />}
                {view.status === 'ok' ? 'Zmień logo' : 'Wgraj logo'}
              </Button>
              {hasLogo ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setConfirmOpen(true)}
                  disabled={pending}
                  className="max-lg:min-h-[44px]"
                >
                  <RiDeleteBinLine aria-hidden />
                  Usuń logo
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!pending) setConfirmOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Usunąć logo?</AlertDialogTitle>
            <AlertDialogDescription>
              PDF faktur, proform i ofert, także pobrane ponownie, będą bez logo. Plik logo usuniemy z FaktWay.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Anuluj</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={pending} onClick={remove}>
              {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
              Usuń logo
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Field>
  );
}
