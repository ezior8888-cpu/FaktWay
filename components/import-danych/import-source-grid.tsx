'use client';

import { useState, type ReactNode } from 'react';
import { RiArrowRightLine, RiFileExcel2Line, type RemixiconComponentType } from '@remixicon/react';

import type { FileImportSource } from '@/app/actions/import-danych';
import { FileImportDialog } from '@/components/onboarding/file-import-dialog';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

import { FILE_SOURCES } from './import-model';

/**
 * „Przeprowadzka z innego programu” — siatka kart z Accounts Finory
 * (`account-card`: przycisk `outline` jako karta, awatar z ikoną i plakietka
 * u góry, nazwa i opis, na dole akcja).
 *
 * Decyzja Bartosza 22.10.2026: historię z KSeF FaktWay pobiera sam (karta
 * „Historia z KSeF” wyżej), więc karty KSeF tu nie ma. Plik zostaje tylko
 * dla czterech dużych programów — bez „Inny program (JPK_FA)”. Każda karta
 * otwiera to samo okno `FileImportDialog` co onboarding
 * (`startFileImportAction`, plik do 1 MB, przejście na stronę postępu).
 *
 * Siatka: dwie kolumny, od `xl` cztery — na telefonie karty stoją parami.
 */

const CARD = 'h-auto w-full flex-col items-stretch gap-4 p-4 text-left whitespace-normal';

function SourceIcon({ icon: Icon }: { icon: RemixiconComponentType }) {
  return (
    <Avatar className="size-9 items-center justify-center">
      <AvatarFallback className="bg-transparent">
        <Icon className="text-foreground size-5" aria-hidden />
      </AvatarFallback>
    </Avatar>
  );
}

function CardBody({
  icon,
  badges,
  title,
  description,
  action,
}: {
  icon: RemixiconComponentType;
  badges: ReactNode;
  title: string;
  description: string;
  action: string;
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <SourceIcon icon={icon} />
        <div className="flex flex-wrap items-center justify-end gap-1.5">{badges}</div>
      </div>
      <div className="flex-1">
        <p className="text-foreground text-sm font-medium wrap-break-word">{title}</p>
        <p className="text-muted-foreground text-sm font-normal wrap-break-word">{description}</p>
      </div>
      <span className="text-primary inline-flex items-center gap-1.5 text-sm font-medium">
        {action}
        <RiArrowRightLine className="size-4" aria-hidden />
      </span>
    </>
  );
}

export function ImportSourceGrid({ tenantId }: { tenantId: string }) {
  const [fileSource, setFileSource] = useState<FileImportSource | null>(null);

  return (
    <section aria-labelledby="przeprowadzka" className="flex flex-col gap-3">
      <div>
        <h2 id="przeprowadzka" className="text-base font-semibold">
          Przeprowadzka z innego programu
        </h2>
        <p className="text-muted-foreground text-sm">Jednorazowo: plik CSV z eksportu faktur.</p>
      </div>
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {FILE_SOURCES.map((source) => (
          <Button
            key={source.id}
            type="button"
            variant="outline"
            onClick={() => setFileSource(source.id)}
            aria-label={`${source.label} — wgraj plik CSV`}
            className={CARD}
          >
            <CardBody
              icon={RiFileExcel2Line}
              badges={
                <Badge variant="secondary" className="font-normal">
                  {source.format}
                </Badge>
              }
              title={source.label}
              description={source.description}
              action="Wgraj plik"
            />
          </Button>
        ))}
      </div>

      {fileSource ? (
        <FileImportDialog source={fileSource} tenantId={tenantId} onClose={() => setFileSource(null)} />
      ) : null}
    </section>
  );
}
