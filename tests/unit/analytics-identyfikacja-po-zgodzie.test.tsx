// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Recenzja #357: identyfikator osoby i firmy wychodzi do PostHoga dopiero po tym,
 * jak konto potwierdzi zgodę. Zgoda w localStorage bywa nieaktualna (odwołana na
 * telefonie) albo cudza (wspólny komputer), więc sama nie wystarcza. Test używa
 * prawdziwego komponentu, prawdziwej synchronizacji i prawdziwego zapisu lokalnego;
 * podstawione są tylko akcja serwerowa i SDK PostHoga.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ action: vi.fn(), identify: vi.fn(), group: vi.fn() }));
vi.mock('@/app/actions/analytics-consent', () => ({ syncAnalyticsConsentAction: mocks.action }));
vi.mock('posthog-js', () => ({
  default: {
    __loaded: true,
    identify: mocks.identify,
    group: mocks.group,
    has_opted_out_capturing: () => false,
  },
}));

const CHOSEN = '2026-11-01T10:00:00.000Z';
let root: Root | null = null;

async function mount(local: 'granted-synced' | 'unset') {
  vi.resetModules();
  const consent = await import('@/lib/analytics/consent');
  if (local === 'granted-synced') consent.adoptAnalyticsConsent('granted', CHOSEN);
  const { AnalyticsIdentify } = await import('@/components/analytics/analytics-identify');
  const sync = await import('@/lib/analytics/consent-sync');
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<AnalyticsIdentify userId="user-1" tenantId="tenant-1" />);
  });
  return sync;
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_unit_test');
  mocks.action.mockReset();
  mocks.identify.mockReset();
  mocks.group.mockReset();
  window.localStorage.clear();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllEnvs();
});

describe('identyfikacja w PostHogu czeka na konto', () => {
  it('konto odwołało zgodę, a localStorage ma jeszcze „granted”: nikt nie jest identyfikowany', async () => {
    mocks.action.mockResolvedValue({ status: 'ok', consent: 'denied', consentAt: CHOSEN });
    await mount('granted-synced');
    await vi.waitFor(() => expect(mocks.action).toHaveBeenCalled());
    await act(async () => undefined);
    expect(mocks.identify).not.toHaveBeenCalled();
    expect(mocks.group).not.toHaveBeenCalled();
  });

  it('konto bez decyzji (wspólny komputer, cudzy „granted”): nikt nie jest identyfikowany', async () => {
    mocks.action.mockResolvedValue({ status: 'ok', consent: null, consentAt: null });
    await mount('granted-synced');
    await vi.waitFor(() => expect(mocks.action).toHaveBeenCalled());
    await act(async () => undefined);
    expect(mocks.identify).not.toHaveBeenCalled();
    expect(mocks.group).not.toHaveBeenCalled();
  });

  it.each([
    ['gość', () => mocks.action.mockResolvedValue({ status: 'anonymous' })],
    ['baza niedostępna', () => mocks.action.mockResolvedValue({ status: 'unavailable' })],
    ['błąd sieci', () => mocks.action.mockRejectedValue(new Error('network'))],
  ])('bez odpowiedzi konta (%s): nikt nie jest identyfikowany', async (_label, respond) => {
    respond();
    await mount('granted-synced');
    await vi.waitFor(() => expect(mocks.action).toHaveBeenCalled());
    await act(async () => undefined);
    expect(mocks.identify).not.toHaveBeenCalled();
    expect(mocks.group).not.toHaveBeenCalled();
  });

  it('konto potwierdza zgodę: osoba i firma są identyfikowane pseudonimowymi id', async () => {
    mocks.action.mockResolvedValue({ status: 'ok', consent: 'granted', consentAt: CHOSEN });
    await mount('granted-synced');
    await vi.waitFor(() => expect(mocks.identify).toHaveBeenCalledWith('user-1'));
    expect(mocks.group).toHaveBeenCalledWith('tenant', 'tenant-1');
  });

  it('zgoda udzielona w banerze po wejściu: identyfikacja dopiero po odpowiedzi konta', async () => {
    mocks.action.mockResolvedValueOnce({ status: 'ok', consent: null, consentAt: null });
    const { chooseAnalyticsConsent } = await mount('unset');
    await vi.waitFor(() => expect(mocks.action).toHaveBeenCalledTimes(1));

    let answer: (value: unknown) => void = () => undefined;
    mocks.action.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    // Bez zwracania obietnicy: `act` czekałby na odpowiedź, która jeszcze nie przyszła.
    await act(async () => { void chooseAnalyticsConsent(true); });
    expect(mocks.identify).not.toHaveBeenCalled();

    await act(async () => answer({ status: 'ok', consent: 'granted', consentAt: CHOSEN }));
    await vi.waitFor(() => expect(mocks.identify).toHaveBeenCalledWith('user-1'));
    expect(mocks.group).toHaveBeenCalledWith('tenant', 'tenant-1');
  });
});
