'use client';

// Plan Finora P15 (E10b): wybór źródła importu na prymitywach Finory (karta
// z ramką, `Button`, `Badge`, ikony Remix) zamiast szkła i zieleni.
//
// Decyzja Bartosza 22.10.2026: Magiczny import znika — historię z KSeF
// FaktWay pobiera sam po wgraniu certyfikatu. Blok KSeF tylko o tym informuje
// (z certyfikatem → postęp w Imporcie danych, bez → ustawienia KSeF). Import
// z pliku zostaje dla czterech dużych programów (`FileImportDialog`), bez
// „Inny program (JPK_FA)”; „Pomiń” przez `skipImportStepAction`.

import { useState, useTransition } from 'react';
import Link from 'next/link';
import {
  RiArrowRightLine,
  RiArrowRightSLine,
  RiFileExcel2Line,
  RiHistoryLine,
  RiLoader4Line,
  RiShieldCheckLine,
} from '@remixicon/react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

import { skipImportStepAction, type FileImportSource } from '@/app/actions/import-danych';
import { FileImportDialog } from './file-import-dialog';

interface Props {
  tenantId: string;
  tenantName: string;
  hasCertificate: boolean;
}

const FILE_IMPORT_OPTIONS: readonly {
  id: FileImportSource;
  label: string;
  sub: string;
}[] = [
  { id: 'fakturownia_csv', label: 'Fakturownia', sub: 'Plik CSV z eksportu' },
  { id: 'infakt_csv', label: 'inFakt', sub: 'Plik CSV z eksportu' },
  { id: 'wfirma_csv', label: 'wFirma', sub: 'Plik CSV z eksportu' },
  { id: 'ifirma_csv', label: 'iFirma', sub: 'Plik CSV z eksportu' },
] as const;

function HistoryBadgeIcon() {
  return (
    <div className="flex size-10 shrink-0 items-center justify-center bg-primary/10 text-primary">
      <RiHistoryLine className="size-5" />
    </div>
  );
}

export function ImportSourceSelector({ tenantId, tenantName, hasCertificate }: Props) {
  const [importType, setImportType] = useState<FileImportSource | null>(null);
  const [isSkipping, startSkip] = useTransition();

  const handleSkip = () => {
    // skipImportStepAction wykonuje server-side redirect → /dashboard (Pulpit)
    // (atomowo, kolejny request leci z aktualnymi cookies).
    startSkip(() => skipImportStepAction());
  };

  const firstName = tenantName.trim().split(/\s+/)[0] ?? '';

  return (
    <div className="space-y-6" data-tenant-id={tenantId}>
      <div>
        <h1 className="mb-2 text-2xl font-semibold">
          {firstName ? `Witaj, ${firstName}!` : 'Witaj!'}
        </h1>
        <p className="text-muted-foreground">
          {hasCertificate
            ? 'Konto firmy gotowe i połączone z KSeF.'
            : 'Konto firmy gotowe. Zostało jeszcze jedno połączenie z KSeF.'}
        </p>
      </div>

      <div className="border border-primary/30 bg-card p-4">
        <div className="flex items-start gap-4">
          <HistoryBadgeIcon />
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold">Historia faktur z KSeF</h3>
              <Badge variant="secondary">{hasCertificate ? 'Automatycznie' : 'Wymaga certyfikatu'}</Badge>
            </div>
            {hasCertificate ? (
              <>
                <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
                  Historia z KSeF pobierze się sama — postęp zobaczysz w Imporcie danych.
                </p>
                <Button variant="outline" render={<Link href="/import-danych" />} nativeButton={false}>
                  Zobacz postęp
                  <RiArrowRightLine />
                </Button>
              </>
            ) : (
              <>
                <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
                  Po wgraniu certyfikatu KSeF pobierzemy historię faktur sami.
                </p>
                <Button render={<Link href="/settings/ksef" />} nativeButton={false}>
                  <RiShieldCheckLine />
                  Wgraj certyfikat KSeF
                  <RiArrowRightLine />
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">Lub przenieś faktury z innego programu (jednorazowo)</p>

        <div className="border bg-card">
          {FILE_IMPORT_OPTIONS.map((opt, idx, arr) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setImportType(opt.id)}
              className={`flex w-full items-center gap-3 p-3 text-left transition-colors hover:bg-muted ${
                idx !== arr.length - 1 ? 'border-b' : ''
              }`}
            >
              <div className="flex size-9 shrink-0 items-center justify-center bg-muted">
                <RiFileExcel2Line className="size-4 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{opt.label}</p>
                <p className="text-xs text-muted-foreground">{opt.sub}</p>
              </div>
              <RiArrowRightSLine className="size-4 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </div>
      </div>

      <div className="pt-2 text-center">
        <Button
          type="button"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground"
          onClick={handleSkip}
          disabled={isSkipping}
        >
          {isSkipping ? (
            <>
              <RiLoader4Line className="animate-spin" />
              Otwieram aplikację...
            </>
          ) : (
            'Pomiń — wejdę do aplikacji'
          )}
        </Button>
      </div>

      {importType && (
        <FileImportDialog source={importType} tenantId={tenantId} onClose={() => setImportType(null)} />
      )}
    </div>
  );
}
