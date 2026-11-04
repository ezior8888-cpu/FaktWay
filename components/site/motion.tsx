'use client';

import type { ReactNode } from 'react';
import { MotionConfig, motion, type Variants } from 'framer-motion';

import { cn } from '@/lib/utils';

/*
 * Animacje stron przed logowaniem: wejście przy załadowaniu i odsłanianie
 * przy przewijaniu. Jedna krzywa i jedne czasy dla wszystkich stron.
 * `SiteMotion` w układzie strony przekazuje `prefers-reduced-motion`:
 * przy włączonej opcji elementy pojawiają się bez przesunięć.
 */

export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

/** Przy przewijaniu: element odsłania się raz, gdy wejdzie w ekran. */
const VIEWPORT = { once: true, amount: 0.2 } as const;

export function SiteMotion({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}

type RevealProps = {
  children: ReactNode;
  className?: string;
  /** Opóźnienie w sekundach (kolejność w obrębie sekcji). */
  delay?: number;
  /** Od razu po załadowaniu strony zamiast po wejściu w ekran. */
  onLoad?: boolean;
  /** Przesunięcie startowe w pikselach. */
  y?: number;
};

/**
 * Pojedynczy element: wyjeżdża lekko z dołu i nabiera krycia.
 *
 * `onLoad` idzie przez CSS (tw-animate-css), nie przez JavaScript: treść nad
 * zgięciem strony i formularze logowania są widoczne od razu po przyjściu
 * HTML-a, także gdy skrypty ładują się wolno.
 */
export function Reveal({ children, className, delay = 0, onLoad = false, y = 24 }: RevealProps) {
  if (onLoad) {
    return (
      <div
        className={cn(
          'animate-in fade-in fill-mode-both motion-reduce:animate-none',
          y < 0 ? 'slide-in-from-top-3' : 'slide-in-from-bottom-6',
          className,
        )}
        style={{
          animationDuration: '700ms',
          animationDelay: `${delay}s`,
          animationTimingFunction: `cubic-bezier(${EASE_OUT.join(',')})`,
        }}
      >
        {children}
      </div>
    );
  }
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={VIEWPORT}
      transition={{ duration: 0.7, delay, ease: EASE_OUT }}
    >
      {children}
    </motion.div>
  );
}

const groupVariants: Variants = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.08 } },
};

const itemVariants: Variants = {
  hidden: { opacity: 0, y: 20 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE_OUT } },
};

/** Lista, której elementy (`RevealItem`) odsłaniają się po kolei. */
export function RevealGroup({
  children,
  className,
  as = 'div',
  onLoad = false,
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'ul' | 'ol' | 'dl';
  onLoad?: boolean;
}) {
  const Component = motion[as];
  return (
    <Component
      className={className}
      variants={groupVariants}
      initial="hidden"
      {...(onLoad ? { animate: 'shown' } : { whileInView: 'shown', viewport: VIEWPORT })}
    >
      {children}
    </Component>
  );
}

export function RevealItem({
  children,
  className,
  as = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'li';
}) {
  const Component = motion[as];
  return (
    <Component className={cn(className)} variants={itemVariants}>
      {children}
    </Component>
  );
}
