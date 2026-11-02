import * as Sentry from '@sentry/nextjs';
import { sentryPrivacyOptions } from '@/lib/observability/scrub';
import { tracesSampler } from '@/lib/observability/sentry-sampling';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  ...sentryPrivacyOptions,
  // Bez healthchecków, telemetrii i prefetchu (plan skalowania, sesja 23).
  tracesSampler,
  debug: false,
  ignoreErrors: ['NEXT_NOT_FOUND', 'NEXT_REDIRECT', 'NonRetriableError'],
  environment: process.env.APP_ENV ?? process.env.NODE_ENV,
  enabled: process.env.NODE_ENV === 'production',
});
