'use client';

import { motion } from 'motion/react';

import { usePrefersReducedMotion } from '@/hooks/use-media-query';

/**
 * Dekoracyjne, animowane orby tła dla landing page (Faza 19). Respektuje
 * `prefers-reduced-motion` — gdy user wyłączył animacje, renderuje statyczne
 * gradient bloby zamiast oscylacji. `pointer-events-none` żeby nie blokować
 * klików w heroes/CTA pod spodem.
 *
 * Trzy orby ułożone tak, żeby pokryć hero (1 środkowy duży) i sąsiadujące
 * sekcje (2 z boków). Wartości w `vw/vh` żeby skalowały się z viewportem.
 */
export function FloatingOrbs() {
  const reduceMotion = usePrefersReducedMotion();

  if (reduceMotion) {
    return (
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute top-[-10vh] left-[-15vw] h-[55vh] w-[55vw] rounded-full bg-purple-500/20 blur-3xl" />
        <div className="absolute top-[20vh] right-[-10vw] h-[60vh] w-[55vw] rounded-full bg-blue-500/15 blur-3xl" />
        <div className="absolute top-[80vh] left-[20vw] h-[50vh] w-[60vw] rounded-full bg-emerald-500/10 blur-3xl" />
      </div>
    );
  }

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <motion.div
        className="absolute top-[-10vh] left-[-15vw] h-[55vh] w-[55vw] rounded-full bg-purple-500/20 blur-3xl"
        animate={{
          x: [0, 30, -20, 0],
          y: [0, -25, 15, 0],
          scale: [1, 1.1, 0.95, 1],
        }}
        transition={{ duration: 28, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute top-[20vh] right-[-10vw] h-[60vh] w-[55vw] rounded-full bg-blue-500/15 blur-3xl"
        animate={{
          x: [0, -35, 20, 0],
          y: [0, 25, -15, 0],
          scale: [1, 0.95, 1.08, 1],
        }}
        transition={{ duration: 34, repeat: Infinity, ease: 'easeInOut', delay: 4 }}
      />
      <motion.div
        className="absolute top-[80vh] left-[20vw] h-[50vh] w-[60vw] rounded-full bg-emerald-500/10 blur-3xl"
        animate={{
          x: [0, 25, -30, 0],
          y: [0, -20, 25, 0],
          scale: [1, 1.05, 0.92, 1],
        }}
        transition={{ duration: 31, repeat: Infinity, ease: 'easeInOut', delay: 8 }}
      />
    </div>
  );
}
