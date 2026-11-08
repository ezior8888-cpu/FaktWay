'use client';

import { useState, type ReactNode } from 'react';
import { RiCameraLine, RiImageLine, RiLoader4Line } from '@remixicon/react';

import { useExpenseCapture } from '@/components/expenses/use-expense-capture';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { MOBILE_MEDIA } from '@/hooks/use-mobile';
import { ACTION_FILE_LIMIT_LABEL } from '@/lib/upload-limit';
import { cn } from '@/lib/utils';

export function CaptureButton({
  triggerClassName,
}: {
  triggerClassName?: string;
} = {}) {
  // Strona arkusza ustalana przy otwarciu (telefon: od dołu, jak wcześniej;
  // od `lg`: z prawej, jak arkusz „Add Transaction” Finory).
  const [sheetSide, setSheetSide] = useState<'bottom' | 'right'>('right');
  const [showSheet, setShowSheet] = useState(false);
  // Wgranie, odczyt i przejście do wydatku — wspólne z plusem dolnego paska.
  const { state, busy, openCamera, openGallery, inputs } = useExpenseCapture({
    onFileChosen: () => setShowSheet(false),
  });

  return (
    <>
      <Button
        onClick={() => {
          setSheetSide(window.matchMedia?.(MOBILE_MEDIA).matches ? 'bottom' : 'right');
          setShowSheet(true);
        }}
        disabled={busy}
        className={triggerClassName}
      >
        {state.kind === 'uploading' || state.kind === 'processing' ? (
          <>
            <RiLoader4Line className="animate-spin" />
            {state.kind === 'uploading' ? 'Wgrywanie...' : 'Rozpoznaję...'}
          </>
        ) : (
          '+ Dodaj wydatek'
        )}
      </Button>

      {inputs}

      {/* Finora: „+ Add Transaction” otwiera arkusz (create-transaction-sheet,
          `SheetContent className='sm:max-w-md'`). U nas arkusz ma dwa wyjścia:
          aparat i plik; na telefonie wysuwa się od dołu, jak wcześniej. */}
      <Sheet open={showSheet} onOpenChange={setShowSheet}>
        <SheetContent
          side={sheetSide}
          className={cn('sm:max-w-md', sheetSide === 'bottom' && 'gap-0 p-0 pb-[var(--ff-safe-b)]')}
        >
          <SheetHeader>
            <SheetTitle>Dodaj wydatek</SheetTitle>
            <SheetDescription>Zdjęcie paragonu albo faktury — dane odczytamy sami.</SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-3 px-4">
            <CaptureOption
              icon={<RiCameraLine />}
              title="Zrób zdjęcie"
              description="Na telefonie otwiera od razu aparat tylny"
              onClick={openCamera}
              highlighted
            />
            <CaptureOption
              icon={<RiImageLine />}
              title="Wybierz z galerii"
              description="Zdjęcie lub PDF z plików"
              onClick={openGallery}
            />
          </div>
          <SheetFooter>
            <p className="text-muted-foreground text-center text-xs">
              Akceptujemy: paragon, faktura VAT, faktura uproszczona. Zdjęcia zmniejszamy sami, PDF do {ACTION_FILE_LIMIT_LABEL}.
            </p>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}

function CaptureOption({
  icon,
  title,
  description,
  onClick,
  highlighted = false,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  highlighted?: boolean;
}) {
  return (
    <Button variant="outline" onClick={onClick} className="h-auto w-full justify-start gap-3 p-4 text-left whitespace-normal">
      <Avatar className="size-10 after:border-0">
        <AvatarFallback
          className={cn('[&>svg]:size-5', highlighted ? 'bg-primary/10 text-primary dark:bg-primary/25' : 'bg-muted text-foreground')}
        >
          {icon}
        </AvatarFallback>
      </Avatar>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-foreground text-sm font-medium">{title}</span>
        <span className="text-muted-foreground text-xs font-normal">{description}</span>
      </span>
    </Button>
  );
}
