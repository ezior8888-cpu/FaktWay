import { cn } from '@/lib/utils';

import { WIZARD_STEPS } from './wizard-model';

/**
 * Nagłówek kreatora: „Krok 2 z 5” i tytuł kroku (czytelne przy 390 px), pod
 * spodem pasek pięciu odcinków. Bez plakietek nad nagłówkiem: numer jest
 * zwykłym tekstem, a tytuł nagłówkiem.
 */
export function WizardProgress({ current }: { current: number }) {
  const title = WIZARD_STEPS.find((s) => s.number === current)?.title ?? '';
  return (
    <div className="flex flex-col gap-2" data-testid="ksef-wizard-progress">
      <p className="text-muted-foreground text-xs" data-testid="ksef-wizard-step">
        Krok {current} z {WIZARD_STEPS.length}
      </p>
      <h2 className="text-base font-medium" aria-live="polite">
        {title}
      </h2>
      <div className="flex gap-1.5" aria-hidden>
        {WIZARD_STEPS.map((s) => (
          <span
            key={s.number}
            className={cn('h-1 flex-1', s.number <= current ? 'bg-primary' : 'bg-muted')}
          />
        ))}
      </div>
    </div>
  );
}
