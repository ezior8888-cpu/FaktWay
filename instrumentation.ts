import * as Sentry from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');

    const { registerPostHogProcessShutdown } = await import(
      '@/lib/analytics/posthog-process-shutdown'
    );
    registerPostHogProcessShutdown();

    // Linia `process.metrics` co 60 s w logu kontenera (plan skalowania, sesja 23).
    const { startProcessMetrics } = await import('@/lib/observability/process-metrics');
    startProcessMetrics({ process: 'web' });
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

export const onRequestError = Sentry.captureRequestError;
