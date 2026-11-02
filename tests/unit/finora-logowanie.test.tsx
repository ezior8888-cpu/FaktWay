import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan Finora P15 (E10b): ekrany logowania, onboarding i zaproszenie na
 * układzie Finory (`src/views/pages/auth/*`). Pilnuje:
 *  - kontraktu e2e (`e2e/pages/auth-page.ts`): `id='email'`, `id='password'`,
 *    przycisk „Zaloguj się”, przycisk rejestracji „Utwórz konto”;
 *  - tłumaczeń z §5 P15 (bez Facebooka i „Remember me”);
 *  - niebieskiej prawej połowy w stylu strony głównej (od 23.10.2026,
 *    wcześniej czarna z tłem ze znaków Finory);
 *  - braku starego wyglądu (szkło, `.zova`) na przeniesionych ekranach.
 */

const mocks = vi.hoisted(() => ({
  google: vi.fn(),
  closed: vi.fn(),
  push: vi.fn(),
}));

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/auth/oauth-providers', () => ({ isGoogleLoginEnabled: mocks.google }));
vi.mock('@/lib/feature-flags/signups', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/feature-flags/signups')>()),
  isSignupClosed: mocks.closed,
}));
vi.mock('@/components/auth/turnstile-widget', () => ({ TurnstileWidget: () => null }));
vi.mock('@/app/(auth)/login/actions', () => ({ loginWithEmail: vi.fn(), loginWithGoogle: vi.fn() }));
vi.mock('@/app/(auth)/register/actions', () => ({ signupWithEmail: vi.fn() }));
vi.mock('@/app/(auth)/forgot-password/actions', () => ({ requestPasswordReset: vi.fn() }));
vi.mock('@/app/actions/import-danych', () => ({
  skipImportStepAction: vi.fn(),
  startFileImportAction: vi.fn(),
}));
vi.mock('@/app/actions/organizations', () => ({
  acceptInvitationAction: vi.fn(),
  requestJoinAction: vi.fn(),
  skipOnboardingWithoutNipAction: vi.fn(),
}));
vi.mock('@/components/onboarding/actions', () => ({
  completeOnboardingAction: vi.fn(),
  lookupNipAction: vi.fn(),
}));
vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push, refresh: vi.fn(), replace: vi.fn() }),
  redirect: (path: string) => { throw new Error('redirect:' + path); },
}));

import LoginPage from '@/app/(auth)/login/page';
import RegisterPage from '@/app/(auth)/register/page';
import ForgotPasswordPage from '@/app/(auth)/forgot-password/page';
import FinishPage from '@/app/auth/finish/page';
import { AuthMessage } from '@/components/auth/finora/auth-message';
import {
  AUTH_SLOGAN_TEXT,
  AUTH_SLOGAN_TITLE,
  AuthSplitLayout,
} from '@/components/auth/finora/auth-split-layout';
import { PasswordInput } from '@/components/auth/finora/password-input';
import { InviteAcceptForm } from '@/components/invite/invite-accept-form';
import { OnboardingForm } from '@/components/onboarding/form';
import { ImportProgressView, type ImportJobRow } from '@/components/onboarding/import-progress-view';
import { ImportSourceSelector } from '@/components/onboarding/import-source-selector';
import { tekstBezZnacznikow } from './helpers/tekst-html';

const ROOT = join(__dirname, '..', '..');

/** Stary wygląd, który na przeniesionych ekranach nie może zostać (§9 pkt 5). */
const OLD_LOOK = /rgba\(15,10,30|white\/55|backdrop-blur|ff-glass-pane|\bzova\b|var\(--z-|glass-primary|bg-glass/;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.google.mockResolvedValue(true);
  mocks.closed.mockResolvedValue(false);
});

async function login(params: Record<string, string> = {}) {
  return renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve(params) }));
}

async function register(params: Record<string, string> = {}) {
  return renderToStaticMarkup(await RegisterPage({ searchParams: Promise.resolve(params) }));
}

async function forgot(params: Record<string, string> = {}) {
  return renderToStaticMarkup(await ForgotPasswordPage({ searchParams: Promise.resolve(params) }));
}

function buttonsNamed(html: string, name: string): number {
  // Tekst przycisku bez znaczników (ikona, spany) — tak liczy nazwę Playwright.
  return [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)]
    .map((m) => tekstBezZnacznikow(m[1]).trim())
    .filter((text) => text === name).length;
}

describe('układ logowania (AuthSplitLayout)', () => {
  it('lewa połowa: logo do strony głównej, hasło nad formularzem na telefonie, treść', () => {
    const html = renderToStaticMarkup(
      <AuthSplitLayout panelTitle='Tytuł panelu' panelText='Tekst panelu'>
        <p>Treść strony</p>
      </AuthSplitLayout>,
    );
    expect(html).toContain('href="/"');
    // Logo FaktWay z zestawu (25.10.2026): wbudowany SVG z etykietą dla czytników ekranu.
    expect(html).toContain('role="img" aria-label="FaktWay"');
    expect(html).toMatch(new RegExp(`<p class="[^"]*lg:hidden[^"]*">${AUTH_SLOGAN_TITLE} ${AUTH_SLOGAN_TEXT}</p>`));
    expect(html).toContain('<p>Treść strony</p>');
  });

  it('prawa połowa: ukryta poniżej lg, tytuł i tekst panelu, hasło FaktWay w karcie', () => {
    const html = renderToStaticMarkup(
      <AuthSplitLayout panelTitle='Tytuł panelu' panelText='Tekst panelu'>
        <p>x</p>
      </AuthSplitLayout>,
    );
    expect(html).toContain('max-lg:hidden');
    expect(html).toContain('Tytuł panelu');
    expect(html).toContain('Tekst panelu');
    expect(AUTH_SLOGAN_TITLE).toBe('Faktury w KSeF bez stresu.');
    // Bez obietnicy FLO, którego klient nie ma (agent niewdrożony).
    expect(AUTH_SLOGAN_TEXT).toBe('Wystawiasz fakturę, my wysyłamy ją do KSeF i pilnujemy potwierdzenia.');
    expect(html.split(AUTH_SLOGAN_TITLE).length - 1).toBe(2); // telefon + karta
    // Od 23.10.2026 prawa połowa niebieska jak strona główna: tokeny motywu
    // (bg-primary / text-primary-foreground), karta faktury z krokami KSeF.
    expect(html).toContain('bg-primary');
    expect(html).toContain('text-primary-foreground');
    expect(html).not.toContain('#000000');
    expect(html).toContain('Wysłana do KSeF');
    expect(html).toContain('Potwierdzenie UPO pobrane');
    // Bez plików graficznych: logo jest wbudowanym SVG (zielony znak zdjęty 23.10.2026).
    expect(html).not.toContain('<img');
    expect(html).not.toMatch(/text-foreground[^"]*xl:text-5xl/);
    expect(html).not.toMatch(OLD_LOOK);
  });

  it('korzeń niesie ff-dashboard (skala SM i font presetu) i kontener portali', () => {
    const html = renderToStaticMarkup(
      <AuthSplitLayout panelTitle='a' panelText='b'>
        <p>x</p>
      </AuthSplitLayout>,
    );
    expect(html).toMatch(/^<div class="ff-dashboard min-h-dvh/);
    expect(html).toContain('data-slot="portal-root"');
  });
});

describe('logowanie (login/index.tsx Finory)', () => {
  it('kontrakt e2e: pola #email i #password, jeden przycisk „Zaloguj się”', async () => {
    const html = await login();
    expect(html).toContain('id="email"');
    expect(html).toContain('name="email"');
    expect(html).toContain('id="password"');
    expect(html).toContain('name="password"');
    expect(html).toContain('autoComplete="current-password"');
    expect(buttonsNamed(html, 'Zaloguj się')).toBe(1);
    expect(html).toMatch(/<h2[^>]*>Zaloguj się<\/h2>/);
  });

  it('teksty z P15: Google, „lub e‑mailem”, „Nie pamiętasz hasła?”, „Nie masz konta? Utwórz konto”', async () => {
    const html = await login();
    expect(html).toContain('Zaloguj przez Google');
    expect(html).toContain('lub e‑mailem');
    expect(html).toMatch(/href="\/forgot-password"[^>]*>Nie pamiętasz hasła\?<\/a>/);
    expect(html).toContain('Nie masz konta?');
    expect(html).toMatch(/href="\/register"[^>]*>Utwórz konto<\/a>/);
    expect(html).toContain('Witaj ponownie!');
  });

  // Od FW1 „Zapamiętaj mnie” działa naprawdę (przy nim `IdleWatcher` nie wylogowuje),
  // więc pole wróciło po polsku; angielska nazwa z Finory dalej ma się nie pojawić.
  it('wylatuje Facebook; „Zapamiętaj mnie” po polsku; brak angielskich tekstów Finory', async () => {
    const html = await login();
    expect(html).not.toMatch(/facebook/i);
    expect(html).toContain('Zapamiętaj mnie');
    expect(html).not.toMatch(/Remember me/i);
    expect(html).not.toMatch(/Welcome|Login with|Sign in|Forgot Password|Create an account|Finora|Shadcn/);
    expect(html).not.toMatch(OLD_LOOK);
  });

  it('bez Google w GoTrue: bez przycisku i bez separatora', async () => {
    mocks.google.mockResolvedValue(false);
    const html = await login();
    expect(html).not.toContain('Zaloguj przez Google');
    expect(html).not.toContain('lub e‑mailem');
    expect(html).toContain('id="password"');
  });

  it('błąd ma role=alert, potwierdzenie role=status', async () => {
    const html = await login({ error: 'invalid_credentials', success: 'session_expired' });
    expect(html).toMatch(/role="alert"[^>]*data-tone="error"/);
    expect(html).toContain('Nieprawidłowy email lub hasło');
    expect(html).toMatch(/role="status"[^>]*data-tone="success"/);
    expect(html).toContain('Wylogowaliśmy Cię po godzinie bezczynności');
  });
});

describe('rejestracja (register/index.tsx Finory)', () => {
  it('kontrakt e2e: #email, #password, przycisk „Utwórz konto”', async () => {
    const html = await register();
    expect(html).toContain('id="email"');
    expect(html).toContain('id="password"');
    expect(html).toContain('minLength="12"');
    expect(html).toContain('autoComplete="new-password"');
    expect(html).toContain('id="name"');
    expect(buttonsNamed(html, 'Utwórz konto')).toBe(1);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Utwórz konto<\/button>/);
  });

  it('/login: informacja o regulaminie i polityce prywatności (Google zakłada konto)', async () => {
    const html = await login();
    expect(html).toContain('href="/legal/regulamin"');
    expect(html).toContain('href="/legal/polityka-prywatnosci"');
  });

  it('regulamin w miejscu pola zgody, odsyłacz do logowania, bez angielskich tekstów', async () => {
    const html = await register();
    expect(html).toContain('href="/legal/regulamin"');
    expect(html).toContain('href="/legal/polityka-prywatnosci"');
    expect(html).toMatch(/Masz już konto\?[\s\S]*href="\/login"[^>]*>Zaloguj się<\/a>/);
    expect(html).toContain('Zarejestruj przez Google');
    expect(html).not.toMatch(/Terms|Privacy Policy|Sign up|Already have|free trial/);
    expect(html).not.toMatch(OLD_LOOK);
  });

  it('wyłączona rejestracja: komunikat w układzie Finory, bez formularza', async () => {
    mocks.closed.mockResolvedValue(true);
    const html = await register();
    expect(html).toContain('Rejestracja nowych kont jest chwilowo wstrzymana');
    expect(html).toContain('max-lg:hidden');
    expect(html).not.toContain('name="password"');
    expect(html).not.toContain('Google');
  });
});

describe('reset hasła (forgot-password/index.tsx Finory)', () => {
  it('pole #email, przycisk wysyłki, powrót do logowania', async () => {
    const html = await forgot();
    expect(html).toContain('id="email"');
    expect(html).toContain('maxLength="254"');
    expect(buttonsNamed(html, 'Wyślij link resetujący')).toBe(1);
    expect(html).toMatch(/<a[^>]*href="\/login"[^>]*>[\s\S]*Wróć do logowania<\/a>/);
    expect(html).toMatch(/<h2[^>]*>Nie pamiętasz hasła\?<\/h2>/);
    expect(html).not.toMatch(/Back to login|Send Reset Link|No worries/);
  });

  it('potwierdzenie wysyłki jako role=status', async () => {
    const html = await forgot({ success: 'email_sent' });
    expect(html).toMatch(/role="status"[^>]*data-tone="success"/);
    expect(html).toContain('otrzymasz link do resetu hasła');
  });
});

describe('prymitywy ekranów logowania', () => {
  it('pole hasła z okiem przepuszcza atrybuty i ma polską etykietę przycisku', () => {
    const html = renderToStaticMarkup(
      <PasswordInput id='password' name='password' required minLength={12} autoComplete='new-password' />,
    );
    expect(html).toContain('type="password"');
    expect(html).toContain('id="password"');
    expect(html).toContain('name="password"');
    expect(html).toContain('minLength="12"');
    expect(html).toContain('type="button"');
    expect(html).toContain('Pokaż hasło');
  });

  it('AuthMessage: błąd alert, potwierdzenie status', () => {
    expect(renderToStaticMarkup(<AuthMessage tone='error'>Błąd</AuthMessage>)).toMatch(/role="alert"/);
    expect(renderToStaticMarkup(<AuthMessage tone='success'>OK</AuthMessage>)).toMatch(/role="status"/);
  });

  it('ekran /auth/finish: karta Finory, bez dawnych klas landingu', () => {
    const html = renderToStaticMarkup(<FinishPage />);
    expect(html).toContain('data-slot="card"');
    expect(html).toContain('Sprawdzam link…');
    expect(html).not.toMatch(OLD_LOOK);
  });
});

describe('onboarding i zaproszenie (styl kart P15)', () => {
  it('kreator: trzy zakładki z nazwami, NIP z przyciskiem w tym samym rodzicu', () => {
    const html = renderToStaticMarkup(<OnboardingForm />);
    for (const name of ['Załóż firmę', 'Mam zaproszenie', 'Poproś o dostęp']) {
      expect(html).toMatch(new RegExp(`role="tab"[^>]*aria-label="${name}"|aria-label="${name}"[^>]*role="tab"`));
    }
    // e2e: `#nip` → `..` → `getByRole('button')`.
    expect(html).toMatch(/data-slot="input-group"[^>]*>(?:(?!data-slot="input-group").)*id="nip"[\s\S]*?aria-label="Szukaj firmy w GUS"/);
    expect(html).toContain('Pomiń — uzupełnię NIP później');
    expect(html).not.toMatch(OLD_LOOK);
  });

  it('kreator z tokenem zaczyna od zakładki zaproszenia (pole #invite-token)', () => {
    const html = renderToStaticMarkup(<OnboardingForm initialInviteToken='synthetic-token' />);
    expect(html).toContain('id="invite-token"');
    expect(html).toContain('value="synthetic-token"');
  });

  // Decyzja Bartosza 22.10.2026 — świadoma zmiana oczekiwań: Magiczny import
  // znika. Blok KSeF tylko informuje (z certyfikatem → postęp w Imporcie
  // danych, bez → ustawienia KSeF), z pliku zostają cztery programy, „Pomiń”
  // bez zmian (e2e 02).
  it('źródło importu: historia z KSeF sama — bez certyfikatu do /settings/ksef, z certyfikatem postęp w Imporcie danych', () => {
    const bez = renderToStaticMarkup(<ImportSourceSelector tenantId='t1' tenantName='Fixture Sp. z o.o.' hasCertificate={false} />);
    expect(bez).toContain('href="/settings/ksef"');
    expect(bez).toContain('Witaj, Fixture!');
    expect(bez).toContain('Po wgraniu certyfikatu KSeF pobierzemy historię faktur sami.');
    expect(bez).not.toContain('href="/import-danych"');
    const z = renderToStaticMarkup(<ImportSourceSelector tenantId='t1' tenantName='' hasCertificate />);
    expect(z).toContain('Historia z KSeF pobierze się sama — postęp zobaczysz w Imporcie danych.');
    expect(z).toContain('href="/import-danych"');
    expect(z).toContain('Witaj!');
    for (const html of [bez, z]) {
      for (const name of ['Fakturownia', 'inFakt', 'wFirma', 'iFirma']) expect(html).toContain(`>${name}<`);
      expect(html).not.toContain('Inny program');
      expect(html).not.toContain('JPK_FA');
      expect(html).not.toContain('Magiczny');
      expect(html).not.toContain('/onboarding/magic-import');
      expect(html).toContain('Pomiń — wejdę do aplikacji');
      expect(html).not.toMatch(OLD_LOOK);
      expect(html).not.toMatch(/emerald|purple/);
    }
  });

  const job = (patch: Partial<ImportJobRow>): ImportJobRow => ({
    id: 'job-1', status: 'extracting', progress_percent: 40, progress_message: 'Pobieram faktury',
    source: 'ksef', invoices_found: 12, invoices_imported: 0, contractors_created: 0,
    contractors_updated: 0, products_created: 0, warnings: [],
    ...patch,
  } as ImportJobRow);

  it('postęp importu: w toku (belka), gotowe (liczby), błąd (komunikat)', () => {
    const running = renderToStaticMarkup(<ImportProgressView initialJob={job({})} />);
    expect(running).toContain('role="progressbar"');
    expect(running).toContain('aria-valuenow="40"');
    expect(running).toContain('width:40%');
    expect(running).toContain('Pobieram faktury');

    const done = renderToStaticMarkup(<ImportProgressView initialJob={job({
      status: 'completed', invoices_imported: 7, contractors_created: 2, contractors_updated: 1, products_created: 4,
    })} />);
    expect(done).toContain('Import zakończony!');
    expect(done).toMatch(/>7<\/p>/);
    expect(done).toMatch(/>3<\/p>/);
    expect(done).toMatch(/>4<\/p>/);

    const failed = renderToStaticMarkup(<ImportProgressView initialJob={job({ status: 'failed', progress_message: 'Brak certyfikatu' })} />);
    expect(failed).toContain('Import się nie udał');
    expect(failed).toMatch(/role="alert"[^>]*>Brak certyfikatu/);
    for (const html of [running, done, failed]) expect(html).not.toMatch(OLD_LOOK);
    // Decyzja Bartosza 22.10.2026: import z pliku nie wysyła e-maila — nie obiecujemy go.
    expect(running).not.toMatch(/e-?mail/i);
    expect(running).toContain('Wynik zobaczysz w Imporcie danych.');
  });

  it('postęp dawnego ręcznego importu z KSeF „w toku”: przerwany, prowadzi do Importu danych', () => {
    const legacy = renderToStaticMarkup(<ImportProgressView initialJob={job({ source: 'ksef_history', status: 'extracting' })} />);
    expect(legacy).toContain('Import przerwany');
    expect(legacy).toContain('Przerwany — zastąpiony automatyczną historią z KSeF.');
    expect(legacy).toContain('Przejdź do Importu danych');
    expect(legacy).not.toContain('role="progressbar"');
    // Poprawka po przeglądzie (decyzja Bartosza 22.10.2026): nieudany dawny
    // import z KSeF też jest zastąpiony — bez „ponów import” i bez
    // „Spróbuj ponownie” prowadzącego do ekranu, na którym tego importu nie ma.
    const failedLegacy = renderToStaticMarkup(<ImportProgressView initialJob={job({
      source: 'ksef_history', status: 'failed', invoices_imported: 5,
      progress_message: 'Lista faktur KSeF jest niepełna. Zawęź zakres dat i ponów import.',
    })} />);
    expect(failedLegacy).toContain('Import przerwany');
    expect(failedLegacy).toContain('Przerwany — zastąpiony automatyczną historią z KSeF.');
    expect(failedLegacy).toContain('Przejdź do Importu danych');
    expect(failedLegacy).toContain('Zapisano 5 faktur.');
    expect(failedLegacy).not.toContain('ponów import');
    expect(failedLegacy).not.toContain('Spróbuj ponownie');
    expect(failedLegacy).not.toContain('Import się nie udał');
    // Zakończony dawny import pokazuje wynik jak dotąd.
    const done = renderToStaticMarkup(<ImportProgressView initialJob={job({ source: 'ksef_history', status: 'completed', invoices_imported: 3 })} />);
    expect(done).toContain('Import zakończony!');
  });

  it('zaproszenie: przycisk „Dołącz do …”', () => {
    const html = renderToStaticMarkup(<InviteAcceptForm token='t' orgName='Fixture' />);
    expect(html).toContain('Dołącz do Fixture');
    expect(html).not.toMatch(OLD_LOOK);
  });
});

describe('przeniesione ekrany nie wracają do starego wyglądu', () => {
  it.each([
    'app/(auth)/login/page.tsx',
    'app/(auth)/register/page.tsx',
    'app/(auth)/forgot-password/page.tsx',
    'app/(auth)/reset-password/page.tsx',
    'app/(auth)/reset-password/reset-password-form.tsx',
    'app/(auth)/login/two-factor/page.tsx',
    'app/(auth)/login/two-factor/setup/page.tsx',
    'app/(auth)/gdpr/cancel/page.tsx',
    'app/(auth)/gdpr/cancel/cancel-form.tsx',
    'app/auth/finish/page.tsx',
    'app/onboarding/page.tsx',
    'app/onboarding/import-source/page.tsx',
    'app/onboarding/progress/[jobId]/page.tsx',
    'app/invite/[token]/page.tsx',
    'components/onboarding/form.tsx',
    'components/onboarding/import-source-selector.tsx',
    'components/onboarding/import-progress-view.tsx',
    'components/onboarding/file-import-dialog.tsx',
    'components/invite/invite-accept-form.tsx',
  ])('%s', (file) => {
    const src = readFileSync(join(ROOT, file), 'utf8');
    expect(src).not.toMatch(OLD_LOOK);
    expect(src).not.toContain('styles/zova.css');
    expect(src).not.toContain('auth-form-styles');
    expect(src).not.toContain('lucide-react');
  });
});
