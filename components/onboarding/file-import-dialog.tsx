'use client';

// Plan Finora P15 (E10b): okno importu z pliku na `Dialog` Finory (było
// własne okno na rozmytym szkle). Plik idzie trasą `/api/uploads/import`
// (`postImportUpload`), potem przejście na stronę postępu. Limit 10 MB
// (`lib/upload-limit.ts`) — do sesji 31 planu skalowania plik szedł Server
// Action i przechodził najwyżej 1 MB.
// Decyzja Bartosza 22.10.2026: tylko CSV z czterech programów — bez JPK_FA.
// Okno jest montowane przez rodzica tylko na czas wyboru, więc stoi otwarte;
// zamknięcie (X, Esc, klik w tło, „Anuluj”) woła `onClose`, a w trakcie
// wysyłki jest zablokowane jak wcześniej przyciski.

import { useState, useTransition } from 'react';
import { RiFileExcel2Line, RiLoader4Line, RiUploadCloud2Line } from '@remixicon/react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { FileImportSource } from '@/lib/import/file-sources';
import { formatUploadSize, UPLOAD_FILE_LIMIT_BYTES, UPLOAD_FILE_LIMIT_LABEL } from '@/lib/upload-limit';
import { postImportUpload } from '@/lib/uploads/client';

interface Props {
  source: FileImportSource;
  tenantId: string;
  onClose: () => void;
}

const SOURCE_LABELS: Record<FileImportSource, string> = {
  fakturownia_csv: 'Fakturownia CSV',
  infakt_csv: 'inFakt CSV',
  wfirma_csv: 'wFirma CSV',
  ifirma_csv: 'iFirma CSV',
};

const FILE_ACCEPT: Record<FileImportSource, string> = {
  fakturownia_csv: '.csv',
  infakt_csv: '.csv',
  wfirma_csv: '.csv',
  ifirma_csv: '.csv',
};

export function FileImportDialog({ source, tenantId, onClose }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [isUploading, startUpload] = useTransition();

  const handleUpload = () => {
    if (!file) return;

    if (file.size > UPLOAD_FILE_LIMIT_BYTES) {
      toast.error(
        `Plik ma ${formatUploadSize(file.size)}, a można wgrać najwyżej ${UPLOAD_FILE_LIMIT_LABEL}. Wyeksportuj krótszy okres (np. kwartał) i wgraj pliki po kolei.`,
      );
      return;
    }

    startUpload(async () => {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('source', source);
      formData.append('tenantId', tenantId);

      // Nie odrzuca obietnicy: sieć i odpowiedź bez JSON wracają jako polski
      // komunikat (`lib/uploads/client.ts`).
      const result = await postImportUpload(formData);

      if (result.success) {
        toast.success('Import rozpoczęty');
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- pełne przeładowanie po imporcie, zachowanie od fazy 12; zamiana na router.push to osobna decyzja
        window.location.assign(`/onboarding/progress/${result.importJobId}`);
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isUploading) onClose();
      }}
    >
      <DialogContent showCloseButton={!isUploading} className="gap-5 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Import z {SOURCE_LABELS[source]}</DialogTitle>
          <DialogDescription className="text-sm">
            Wgraj plik wyeksportowany ze starego programu
          </DialogDescription>
        </DialogHeader>

        <label className="block cursor-pointer">
          <input
            type="file"
            accept={FILE_ACCEPT[source]}
            disabled={isUploading}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="peer sr-only"
          />
          <div className="border-2 border-dashed p-8 text-center transition-colors hover:border-primary/50 peer-focus-visible:border-primary peer-focus-visible:ring-[3px] peer-focus-visible:ring-ring/50">
            <RiFileExcel2Line className="mx-auto mb-3 size-8 text-muted-foreground" />
            {file ? (
              <>
                <p className="truncate px-2 text-sm font-medium">{file.name}</p>
                <p className="mt-1 font-mono text-xs text-muted-foreground">
                  {formatUploadSize(file.size)}
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium">Kliknij aby wybrać plik</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {FILE_ACCEPT[source]} • max {UPLOAD_FILE_LIMIT_LABEL}
                </p>
              </>
            )}
          </div>
        </label>

        {source === 'fakturownia_csv' && (
          <p className="bg-muted/50 p-3 text-xs leading-relaxed text-muted-foreground">
            <strong>Jak wyeksportować z Fakturowni:</strong> Faktury → Eksport → Format CSV →
            Wybierz okres → Pobierz.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" size="lg" onClick={onClose} disabled={isUploading}>
            Anuluj
          </Button>
          <Button size="lg" onClick={handleUpload} disabled={!file || isUploading}>
            {isUploading ? <RiLoader4Line className="animate-spin" /> : <RiUploadCloud2Line />}
            Rozpocznij import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
