'use client';

import { motion } from 'motion/react';

import { usePrefersReducedMotion } from '@/hooks/use-media-query';

type Direction = 'up' | 'down' | 'left' | 'right';

interface ScrollRevealProps {
  children: React.ReactNode;
  delay?: number;
  direction?: Direction;
  className?: string;
}

const OFFSETS: Record<Direction, { x: number; y: number }> = {
  up: { x: 0, y: 28 },
  down: { x: 0, y: -28 },
  left: { x: 28, y: 0 },
  right: { x: -28, y: 0 },
};

/**
 * Wrapper z animacją wjazdu przy pierwszym pojawieniu się w viewport
 * (`whileInView` + `viewport.once`). Respektuje `prefers-reduced-motion`.
 * Używaj na sekcjach landing page (problems, features, testimonials).
 */
export function ScrollReveal({
  children,
  delay = 0,
  direction = 'up',
  className,
}: ScrollRevealProps) {
  const reduceMotion = usePrefersReducedMotion();

  const offset = OFFSETS[direction];

  // Ten sam element w obu trybach: „ogranicz ruch” przychodzi po hydratacji,
  // a zmiana typu elementu zamontowałaby dzieci od nowa. Wtedy treść
  // pokazuje się od razu, bez czekania na wejście w ekran.
  return (
    <motion.div
      initial={{ opacity: 0, x: offset.x, y: offset.y }}
      animate={reduceMotion ? { opacity: 1, x: 0, y: 0 } : undefined}
      whileInView={reduceMotion ? undefined : { opacity: 1, x: 0, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.55, delay, ease: [0.21, 0.45, 0.27, 0.9] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
