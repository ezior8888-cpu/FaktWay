'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Camera,
  FileText,
  Sparkles,
  Upload,
  type LucideIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/**
 * Welcome modal po onboardingu (Faza 19). Triggerowany przez `?welcome=1`
 * w URL — server-side redirect z onboardingu ustawia ten parametr. Po
 * zamknięciu modalu URL czyścimy `router.replace('/dashboard')`, żeby
 * F5 nie pokazał modalu drugi raz.
 *
 * Trzy ścieżki celowo odzwierciedlają najczęstsze pierwsze akcje (sekcja 1c
 * dokumentu pain-points): wystaw fakturę, wrzuć paragon, zaimportuj historię.
 */
export function WelcomeModal() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (searchParams.get('welcome') === '1') {
      setOpen(true);
    }
  }, [searchParams]);

  const handleClose = () => {
    setOpen(false);
    router.replace('/dashboard');
  };

  const handleNavigate = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : handleClose())}>
      <DialogContent className="max-w-2xl">
        <div className="space-y-6 py-2">
          <div className="text-center space-y-3">
            <div className="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-linear-to-br from-purple-500/20 via-blue-500/15 to-emerald-500/20">
              <Sparkles className="h-7 w-7 text-foreground" aria-hidden />
            </div>
            <DialogTitle className="font-display text-3xl tracking-tighter-display">
              Witaj w FaktWay
            </DialogTitle>
            <DialogDescription className="mx-auto max-w-md text-base text-muted-foreground">
              Twoja firma jest gotowa. Wybierz jak chcesz zacząć — zawsze możesz
              wrócić tu z panelu.
            </DialogDescription>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <PathCard
              icon={FileText}
              title="Wystaw pierwszą fakturę"
              description="Standardowy formularz. Live walidacja NIP-u i KSeF push w 1 kliku."
              onClick={() => handleNavigate('/invoices/new')}
              accent="emerald"
            />
            <PathCard
              icon={Camera}
              title="Sfotografuj paragon"
              description="OCR Claude Vision rozpozna kwoty i wpisze do KPiR automatycznie."
              onClick={() => handleNavigate('/expenses?scan=1')}
              accent="purple"
            />
            <PathCard
              icon={Upload}
              title="Importuj historię"
              description="CSV z Fakturowni, inFaktu, wFirmy albo iFirmy. Historię z KSeF pobieramy sami."
              onClick={() => handleNavigate('/onboarding/import-source')}
              accent="blue"
            />
          </div>

          <div className="flex justify-center pt-2">
            <Button variant="ghost" size="sm" onClick={handleClose}>
              Pominę, pokaż mi panel
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface PathCardProps {
  icon: LucideIcon;
  title: string;
  description: string;
  onClick: () => void;
  accent: 'emerald' | 'purple' | 'blue';
}

const ACCENT_CLASSES: Record<PathCardProps['accent'], string> = {
  emerald:
    'hover:border-emerald-500/30 hover:bg-emerald-500/5 [&_[data-icon]]:text-emerald-600 dark:[&_[data-icon]]:text-emerald-400',
  purple:
    'hover:border-purple-500/30 hover:bg-purple-500/5 [&_[data-icon]]:text-purple-600 dark:[&_[data-icon]]:text-purple-400',
  blue:
    'hover:border-blue-500/30 hover:bg-blue-500/5 [&_[data-icon]]:text-blue-600 dark:[&_[data-icon]]:text-blue-400',
};

function PathCard({ icon: Icon, title, description, onClick, accent }: PathCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group relative flex flex-col gap-3 rounded-2xl border border-glass-border bg-foreground/3 p-5 text-left transition-all',
        'focus:outline-none focus:ring-2 focus:ring-foreground/20',
        ACCENT_CLASSES[accent],
      )}
    >
      <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-foreground/5">
        <Icon data-icon className="h-5 w-5 text-muted-foreground" aria-hidden />
      </div>
      <div className="space-y-1">
        <h3 className="font-semibold text-sm tracking-tight">{title}</h3>
        <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
      </div>
    </button>
  );
}
