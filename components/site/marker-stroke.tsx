'use client';

import { motion } from 'framer-motion';

import { EASE_OUT } from './motion';

/**
 * Podkreślenie słowa w nagłówku: jedna linia „markerem”, rysowana od lewej
 * po załadowaniu strony. `preserveAspectRatio="none"` rozciąga ją pod słowo
 * o dowolnej długości.
 */
export function MarkerStroke({ className, delay = 0.45 }: { className?: string; delay?: number }) {
  return (
    <svg aria-hidden viewBox="0 0 300 24" preserveAspectRatio="none" fill="none" className={className}>
      <motion.path
        d="M6 15 C 64 7, 132 5, 196 9 S 280 14, 294 11"
        stroke="currentColor"
        strokeWidth="11"
        strokeLinecap="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.9, delay, ease: EASE_OUT }}
      />
    </svg>
  );
}
