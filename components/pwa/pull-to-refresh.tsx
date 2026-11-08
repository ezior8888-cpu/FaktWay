'use client';

import { useRef, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { ArrowDown, Loader2 } from 'lucide-react';

import { usePullToRefresh } from '@/hooks/use-pull-to-refresh';

interface Props {
  onRefresh: () => Promise<void> | void;
  /**
   * Odświeżanie trwa poza hakiem (np. `router.refresh()` w przejściu React,
   * które samo nie zwraca obietnicy) — wskaźnik kręci się do jego końca.
   */
  refreshing?: boolean;
  children: ReactNode;
}

export function PullToRefresh({ onRefresh, refreshing = false, children }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { pullDistance, isRefreshing: hookRefreshing, progress } = usePullToRefresh({
    onRefresh,
    targetRef: rootRef,
  });
  const isRefreshing = hookRefreshing || refreshing;

  return (
    <div ref={rootRef} className="relative">
      <motion.div
        animate={{
          height: isRefreshing ? 60 : pullDistance,
          opacity: pullDistance > 10 || isRefreshing ? 1 : 0,
        }}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        className="flex items-center justify-center overflow-hidden"
      >
        <div className="flex flex-col items-center gap-2 py-3">
          {isRefreshing ? (
            <Loader2 className="h-5 w-5 animate-spin text-foreground" />
          ) : (
            <motion.div
              animate={{ rotate: progress >= 1 ? 180 : 0 }}
              transition={{ duration: 0.2 }}
            >
              <ArrowDown
                className={`h-5 w-5 transition-colors ${
                  progress >= 1
                    ? 'text-green-600 dark:text-green-400'
                    : 'text-muted-foreground'
                }`}
              />
            </motion.div>
          )}
          <p className="text-xs text-muted-foreground">
            {isRefreshing
              ? 'Odświeżanie...'
              : progress >= 1
                ? 'Puść aby odświeżyć'
                : 'Pociągnij w dół'}
          </p>
        </div>
      </motion.div>

      {children}
    </div>
  );
}
