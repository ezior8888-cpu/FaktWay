// Hook do live walidacji NIP w formularzach (z debouncing)

'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { validateNipLiveAction } from '@/app/actions/validation';
import type { CachedValidationResult } from '@/lib/validation/cache';

const DEBOUNCE_MS = 800;

interface UseNipValidationOptions {
  enabled?: boolean;
  /** Domyślnie PL lub z polem bez prefiksu (same cyfry). Inne kraje: prefiks przy `validateNipLiveAction`. */
  countryCode?: string;
}

interface UseNipValidationResult {
  status: 'idle' | 'validating' | 'success' | 'error';
  result: CachedValidationResult | null;
  error: string | null;
  validate: (nip: string) => void;
  reset: () => void;
}

function buildVatPayload(cleanNip: string, countryCode?: string): string {
  const cc = countryCode?.trim().toUpperCase();
  if (!cc || cc === 'PL') {
    return cleanNip;
  }
  if (/^[A-Z]{2}/.test(cleanNip)) {
    return cleanNip;
  }
  return `${cc}${cleanNip}`;
}

function treatsInputAsPolish(
  cleanNip: string,
  countryCode?: string,
): boolean {
  const cc = countryCode?.trim().toUpperCase();
  const assumePl = !cc || cc === 'PL';
  return assumePl && /^\d+$/.test(cleanNip);
}

export function useNipValidation(
  options: UseNipValidationOptions = {},
): UseNipValidationResult {
  const { enabled = true, countryCode } = options;

  const enabledRef = useRef(enabled);
  const countryCodeRef = useRef(countryCode);
  // Aktualizacja po commicie, przed efektami, które wołają `validate`.
  useLayoutEffect(() => {
    enabledRef.current = enabled;
    countryCodeRef.current = countryCode;
  });

  const [status, setStatus] = useState<
    'idle' | 'validating' | 'success' | 'error'
  >('idle');
  const [result, setResult] = useState<CachedValidationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Ostatni pełny identyfikatior VAT, który zakończył się sukcesem (bez ponownego strzału do API). */
  const lastSuccessPayloadRef = useRef<string>('');

  const validate = useCallback((nip: string) => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    if (!enabledRef.current) {
      setStatus('idle');
      setResult(null);
      setError(null);
      return;
    }

    const cleanNip = nip.replace(/[\s\-]/g, '');

    if (cleanNip.length === 0) {
      lastSuccessPayloadRef.current = '';
      setStatus('idle');
      setResult(null);
      setError(null);
      return;
    }

    if (cleanNip.length < 4) {
      lastSuccessPayloadRef.current = '';
      setStatus('idle');
      setResult(null);
      return;
    }

    const cc = countryCodeRef.current;
    if (treatsInputAsPolish(cleanNip, cc) && cleanNip.length !== 10) {
      lastSuccessPayloadRef.current = '';
      setStatus('idle');
      setResult(null);
      return;
    }

    const payload = buildVatPayload(cleanNip, cc);
    if (payload === lastSuccessPayloadRef.current) {
      return;
    }

    setStatus('validating');
    setError(null);

    timeoutRef.current = setTimeout(async () => {
      if (!enabledRef.current) {
        setStatus('idle');
        return;
      }

      const innerClean = nip.replace(/[\s\-]/g, '');
      const innerPayload = buildVatPayload(innerClean, countryCodeRef.current);

      try {
        const response = await validateNipLiveAction(innerPayload);

        if (response.success) {
          lastSuccessPayloadRef.current = innerPayload;
          setResult(response.result);
          setStatus('success');
        } else {
          setError(response.error);
          setStatus('error');
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Błąd walidacji');
        setStatus('error');
      } finally {
        timeoutRef.current = null;
      }
    }, DEBOUNCE_MS);
  }, []);

  const reset = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setStatus('idle');
    setResult(null);
    setError(null);
    lastSuccessPayloadRef.current = '';
  }, []);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return { status, result, error, validate, reset };
}
