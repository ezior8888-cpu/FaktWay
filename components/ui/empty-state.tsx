import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';

import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type EmptyStateAction =
  | { type: 'link'; label: string; href: string; icon?: LucideIcon }
  | { type: 'button'; label: string; onClick: () => void; icon?: LucideIcon };

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  primaryAction?: EmptyStateAction;
  secondaryAction?: EmptyStateAction;
  className?: string;
}

/**
 * Generyczny empty state dla list/tabel/widoków bez danych. Zastępuje
 * ad-hoc `<div>Brak X</div>` rozproszone po stronach.
 *
 * Server-component-safe — pod warunkiem że actions to `link` (button
 * wymaga `onClick`, więc trzeba opakować w client component).
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  primaryAction,
  secondaryAction,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'bg-card text-card-foreground ring-foreground/10 rounded-none px-6 py-16 text-center ring-1',
        className,
      )}
    >
      <div className="mx-auto mb-5 inline-flex h-14 w-14 items-center justify-center rounded-none bg-muted">
        <Icon className="h-7 w-7 text-muted-foreground" aria-hidden />
      </div>
      <h3 className="mb-2 text-xl font-semibold tracking-tight">{title}</h3>
      {description ? (
        <p className="mx-auto max-w-md text-sm text-muted-foreground leading-relaxed">
          {description}
        </p>
      ) : null}

      {(primaryAction || secondaryAction) && (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {primaryAction ? renderAction(primaryAction, 'default') : null}
          {secondaryAction ? renderAction(secondaryAction, 'outline') : null}
        </div>
      )}
    </div>
  );
}

function renderAction(
  action: EmptyStateAction,
  variant: 'default' | 'outline',
) {
  const Icon = action.icon;
  const inner = (
    <>
      {Icon ? <Icon className="mr-2 h-4 w-4" aria-hidden /> : null}
      {action.label}
    </>
  );

  if (action.type === 'link') {
    return (
      <Link
        href={action.href}
        key={action.label}
        className={buttonVariants({ variant, size: 'lg' })}
      >
        {inner}
      </Link>
    );
  }

  return (
    <Button
      variant={variant}
      size="lg"
      onClick={action.onClick}
      key={action.label}
    >
      {inner}
    </Button>
  );
}
