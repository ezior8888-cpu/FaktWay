'use client';

import { useEffect, useRef, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { RiCameraLine, RiImageLine, RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import {
  getOcrJobStatusAction,
  uploadExpensePhotoAction,
} from '@/app/actions/expenses';
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
import { sendExpenseFile } from '@/lib/expenses/photo-upload';
import { ACTION_FILE_LIMIT_LABEL } from '@/lib/upload-limit';
import { cn } from '@/lib/utils';

type CaptureState =
  | { kind: 'idle' }
  | { kind: 'uploading' }
  | { kind: 'processing'; jobId: string }
  | { kind: 'failed'; error: string };

export function CaptureButton({
  triggerClassName,
}: {
  triggerClassName?: string;
} = {}) {
  const router = useRouter();
  // Strona arkusza ustalana przy otwarciu (telefon: od dołu, jak wcześniej;
  // od `lg`: z prawej, jak arkusz „Add Transaction” Finory).
  const [sheetSide, setSheetSide] = useState<'bottom' | 'right'>('right');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const [showSheet, setShowSheet] = useState(false);
  const [state, setState] = useState<CaptureState>({ kind: 'idle' });
  const [, startUpload] = useTransition();

  const processingJobId =
    state.kind === 'processing' ? state.jobId : null;

  useEffect(() => {
    if (!processingJobId) return;

    const jobId = processingJobId;
    let cancelled = false;
    const timers: { interval?: ReturnType<typeof setInterval> } = {};
    // Jedno pytanie naraz: odpowiedź wolniejsza niż takt (2 s) nie może
    // nakładać się na następne — dwie odpowiedzi „completed” dałyby
    // podwójny toast i podwójne przejście do wydatku.
    let inFlight = false;

    async function pollOnce() {
      if (cancelled || inFlight) return;
      inFlight = true;
      // Odrzucona obietnica akcji (sieć, restart serwera) to chwilowy błąd —
      // stan zadania nieznany, pytamy przy następnym takcie.
      const status = await getOcrJobStatusAction(jobId).catch(() => null);
      inFlight = false;
      if (cancelled || !status) return;

      if (!status.success) {
        // Chwilowy błąd odczytu: zadanie mogło się udać, więc nie pokazujemy
        // porażki (klient wgrałby zdjęcie drugi raz → drugi wydatek). Pytamy
        // dalej; limit 60 s niżej i tak zakończy czekanie.
        if (status.retryable) return;
        if (timers.interval) clearInterval(timers.interval);
        setState({ kind: 'failed', error: status.error });
        toast.error(status.error);
        return;
      }

      if (status.job.status === 'completed' && status.job.expense_id) {
        if (timers.interval) clearInterval(timers.interval);
        toast.success('Wydatek rozpoznany!');
        router.push(`/expenses/${status.job.expense_id}`);
        setState({ kind: 'idle' });
        return;
      }

      if (status.job.status === 'failed') {
        if (timers.interval) clearInterval(timers.interval);
        setState({
          kind: 'failed',
          error: status.job.error_message ?? 'Nieznany błąd',
        });
        toast.error('Nie udało się rozpoznać');
      }
    }

    void pollOnce();
    timers.interval = setInterval(() => void pollOnce(), 2000);

    const timeoutId = setTimeout(() => {
      cancelled = true;
      if (timers.interval) clearInterval(timers.interval);
      setState((s) =>
        s.kind === 'processing' && s.jobId === jobId
          ? {
              kind: 'failed',
              error: 'Przekroczono czas oczekiwania (60 s).',
            }
          : s,
      );
      toast.error('Przekroczono czas oczekiwania');
    }, 60_000);

    return () => {
      cancelled = true;
      if (timers.interval) clearInterval(timers.interval);
      clearTimeout(timeoutId);
    };
  }, [processingJobId, router]);

  const handleFile = (file: File) => {
    setShowSheet(false);
    setState({ kind: 'uploading' });

    startUpload(async () => {
      // Zdjęcie zmniejszone, plik ponad limit akcji zatrzymany z komunikatem,
      // odrzucona obietnica akcji jako błąd (plan skalowania, sesja 4).
      const result = await sendExpenseFile(file, uploadExpensePhotoAction);

      if (!result.success) {
        setState({ kind: 'failed', error: result.error });
        toast.error(result.error);
        return;
      }

      setState({ kind: 'processing', jobId: result.ocrJobId });
    });
  };

  return (
    <>
      <Button
        onClick={() => {
          setSheetSide(window.matchMedia?.(MOBILE_MEDIA).matches ? 'bottom' : 'right');
          setShowSheet(true);
        }}
        disabled={state.kind === 'uploading' || state.kind === 'processing'}
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

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          e.target.value = '';
        }}
      />
      <input
        ref={galleryInputRef}
        type="file"
        accept="image/*,application/pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          e.target.value = '';
        }}
      />

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
              onClick={() => fileInputRef.current?.click()}
              highlighted
            />
            <CaptureOption
              icon={<RiImageLine />}
              title="Wybierz z galerii"
              description="Zdjęcie lub PDF z plików"
              onClick={() => galleryInputRef.current?.click()}
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
