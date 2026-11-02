'use client';

import { useEffect } from 'react';
import posthog from 'posthog-js';

import { isBrowserPosthogReady } from '@/lib/analytics/browser-posthog';
import {
  ANALYTICS_CONSENT_EVENT,
  hasAnalyticsConsent,
  isAnalyticsConfigured,
} from '@/lib/analytics/consent';
import {
  ANALYTICS_ACCOUNT_EVENT,
  clearAnalyticsAccountConfirmation,
  isAnalyticsConsentConfirmedByAccount,
  syncAnalyticsConsentWithServer,
} from '@/lib/analytics/consent-sync';

export function AnalyticsIdentify({ userId, tenantId }: {
  userId: string;
  tenantId: string;
}) {
  useEffect(() => {
    const identify = () => {
      // Sama zgoda z localStorage nie wystarcza: może być odwołana na innym urządzeniu
      // albo cudza. Osobę i firmę łączymy dopiero po odpowiedzi konta.
      if (!isAnalyticsConsentConfirmedByAccount() || !hasAnalyticsConsent()) return;
      if (!isBrowserPosthogReady() || posthog.has_opted_out_capturing()) return;
      // Analytics needs pseudonymous IDs, never an email address.
      posthog.identify(userId);
      posthog.group('tenant', tenantId);
    };
    identify();
    window.addEventListener(ANALYTICS_CONSENT_EVENT, identify);
    window.addEventListener(ANALYTICS_ACCOUNT_EVENT, identify);
    return () => {
      window.removeEventListener(ANALYTICS_CONSENT_EVENT, identify);
      window.removeEventListener(ANALYTICS_ACCOUNT_EVENT, identify);
    };
  }, [userId, tenantId]);

  // Po zalogowaniu: wybór z tej przeglądarki idzie na konto albo decyzja z konta
  // przychodzi tutaj (ostatni wybór wygrywa). Panel ładuje ten komponent raz na wejście.
  useEffect(() => {
    if (!isAnalyticsConfigured()) return;
    void syncAnalyticsConsentWithServer();
    return clearAnalyticsAccountConfirmation;
  }, [userId]);

  return null;
}
