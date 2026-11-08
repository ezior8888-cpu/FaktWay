import { describe, expect, it } from 'vitest';

import { mfaStepUpHref } from '@/lib/auth/mfa-step-up';
import {
  WIZARD_PATH,
  WIZARD_TWO_FACTOR_HREF,
  deriveWizardStep,
  failureIsPassword,
  failureIsTemporary,
  failureNeedsNewCertificate,
  needsReconfirmation,
  stepNumber,
  type WizardInput,
} from '@/app/(dashboard)/settings/ksef/_components/wizard-model';

const ready: WizardInput = { hasNip: true, isOwner: true, mfa: 'verified', hasCredentials: false, confirmed: false };
const step = (over: Partial<WizardInput>) => deriveWizardStep({ ...ready, ...over });

describe('kreator KSeF: krok liczony z serwera', () => {
  it('bez spełnionych warunków zawsze krok 1, a przy spełnionych krok 2', () => {
    expect(step({})).toBe('certyfikat');
    expect(step({ hasNip: false })).toBe('warunki');
    expect(step({ isOwner: false })).toBe('warunki');
    for (const mfa of ['challenge_required', 'enrollment_required', 'unknown'] as const) {
      expect(step({ mfa })).toBe('warunki');
    }
  });

  it('krok 3 tylko po „Dalej” (?krok=pliki) i tylko gdy warunki nadal są spełnione', () => {
    expect(step({ requested: 'pliki' })).toBe('pliki');
    expect(step({ requested: 'certyfikat' })).toBe('certyfikat');
    // Wygasła sesja 2FA albo utrata roli po powrocie: wracamy do warunków, nie do wgrywania.
    expect(step({ requested: 'pliki', mfa: 'challenge_required' })).toBe('warunki');
    expect(step({ requested: 'pliki', isOwner: false })).toBe('warunki');
  });

  it('nieznana wartość ?krok= nie otwiera niczego poza krokiem 2', () => {
    expect(step({ requested: 'polaczono' })).toBe('certyfikat');
    expect(step({ requested: '../admin' })).toBe('certyfikat');
    expect(step({ requested: null })).toBe('certyfikat');
  });

  it('połączona firma (certyfikat zapisany i potwierdzony) widzi podsumowanie, także gdy nie jest właścicielem i bez 2FA', () => {
    expect(step({ hasCredentials: true, confirmed: true })).toBe('polaczono');
    expect(step({ hasCredentials: true, confirmed: true, isOwner: false, mfa: 'unknown' })).toBe('polaczono');
  });

  it('odnowienie certyfikatu przechodzi tę samą drogę, z warunkami', () => {
    const connected = { hasCredentials: true, confirmed: true };
    expect(step({ ...connected, requested: 'certyfikat' })).toBe('certyfikat');
    expect(step({ ...connected, requested: 'pliki' })).toBe('pliki');
    expect(step({ ...connected, requested: 'pliki', mfa: 'challenge_required' })).toBe('warunki');
  });

  // Recenzja #361, pkt 2: poświadczenia z innego środowiska (TEST przełączony na produkcję) albo
  // ze starym znacznikiem nie pobierają historii, a Import danych każe wgrać certyfikat ponownie.
  // Kreator nie może wtedy mówić „Połączono”.
  describe('poświadczenia bez dowodu w środowisku aplikacji', () => {
    const unconfirmed = { hasCredentials: true, confirmed: false };

    it('prowadzą do kroku z plikami, a nie do podsumowania „Połączono”', () => {
      expect(step(unconfirmed)).toBe('pliki');
      expect(step({ ...unconfirmed, isOwner: false })).toBe('warunki');
      expect(needsReconfirmation(unconfirmed)).toBe(true);
      expect(needsReconfirmation({ hasCredentials: true, confirmed: true })).toBe(false);
      expect(needsReconfirmation({ hasCredentials: false, confirmed: false })).toBe(false);
    });

    it('warunki nadal obowiązują: bez kodu z aplikacji najpierw krok 1', () => {
      for (const mfa of ['challenge_required', 'enrollment_required', 'unknown'] as const) {
        expect(step({ ...unconfirmed, mfa })).toBe('warunki');
      }
    });

    it('klient może świadomie wrócić po nowy certyfikat (krok 2) albo zostać przy plikach', () => {
      expect(step({ ...unconfirmed, requested: 'certyfikat' })).toBe('certyfikat');
      expect(step({ ...unconfirmed, requested: 'pliki' })).toBe('pliki');
    });
  });

  it('numeruje kroki jak w opisie (czwarty to oczekiwanie na trzecim ekranie)', () => {
    expect(['warunki', 'certyfikat', 'pliki', 'polaczono'].map((s) => stepNumber(s as never))).toEqual([1, 2, 3, 5]);
  });

  it('powroty: po odmowie KSeF klient wraca do pobrania certyfikatu, po błędzie hasła zostaje przy plikach', () => {
    for (const reason of ['no_permission', 'not_owner', 'revoked', 'untrusted_issuer', 'cert_expired', 'cert_offline']) {
      expect(failureNeedsNewCertificate(reason)).toBe(true);
    }
    for (const reason of ['password_required', 'password_wrong', 'key_mismatch', 'unavailable', 'internal_error', 'rate_limited', 'rejected']) {
      expect(failureNeedsNewCertificate(reason)).toBe(false);
    }
    expect(failureIsPassword('password_wrong')).toBe(true);
    expect(failureIsPassword('key_mismatch')).toBe(false);
  });

  it('chwilowe porażki (KSeF niedostępny, błąd po naszej stronie) dają przycisk "Spróbuj ponownie", reszta nie', () => {
    expect(failureIsTemporary('unavailable')).toBe(true);
    expect(failureIsTemporary('internal_error')).toBe(true);
    for (const reason of ['rejected', 'rate_limited', 'password_wrong', 'revoked', 'save_failed']) {
      expect(failureIsTemporary(reason)).toBe(false);
    }
  });
});

// Recenzja #361, pkt 6: ręcznie złożony adres ekranu kodu nie miał `potwierdzenie=1` (ekran nie mówił,
// dlaczego pyta o kod) i niekodowanego `redirect`. Jedyne źródło takiego adresu to `mfaStepUpHref`.
describe('kreator KSeF: przejście na ekran kodu', () => {
  it('adres ekranu kodu pochodzi z mfaStepUpHref i wraca do kreatora', () => {
    expect(WIZARD_TWO_FACTOR_HREF).toBe(mfaStepUpHref(WIZARD_PATH));
    expect(WIZARD_TWO_FACTOR_HREF).toBe('/login/two-factor?redirect=%2Fsettings%2Fksef&potwierdzenie=1');
  });
});
