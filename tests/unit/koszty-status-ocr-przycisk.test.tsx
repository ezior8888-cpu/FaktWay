// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E16: przycisk „Dodaj wydatek” po wgraniu zdjęcia odpytuje stan odczytu.
 * Chwilowy błąd (odpowiedź `retryable: true` albo odrzucona obietnica akcji)
 * nie może kończyć czekania porażką — klient wgrałby zdjęcie drugi raz
 * i powstałby drugi wydatek. Pytania nie nakładają się: wolna odpowiedź nie
 * daje podwójnego toastu ani przejścia.
 *
 * Plan skalowania, sesja 11 (REQ-08, CAC-10) — świadoma zmiana oczekiwań:
 * zamiast co 2 s przez całą minutę (31 pytań) pytamy od razu, potem po 2 s,
 * 3 s, 4,5 s, 6,75 s i co 10 s, a ostatnie pytanie 2 s przed limitem, jak
 * dawniej (10 pytań do 58 s). Limit 60 s bez zmian.
 */

type StatusResult = Awaited<
  ReturnType<typeof import('@/app/actions/expenses').getOcrJobStatusAction>
>;

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  upload: vi.fn(),
  router: { push: vi.fn(), refresh: vi.fn() },
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Stały obiekt routera, jak w Next — efekt odpytywania zależy od `router`.
vi.mock('next/navigation', () => ({ useRouter: () => mocks.router }));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('@/app/actions/expenses', () => ({
  getOcrJobStatusAction: mocks.getStatus,
}));
// Wgranie: trasa `/api/uploads/expense` (plan skalowania, sesja 31).
vi.mock('@/lib/uploads/client', () => ({ postExpenseUpload: mocks.upload }));

import { CaptureButton } from '@/components/expenses/capture-button';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const EXPENSE_ID = '22222222-2222-4222-8222-222222222222';

const RETRYABLE: StatusResult = {
  success: false,
  retryable: true,
  error: 'Nie mogę teraz sprawdzić stanu odczytu',
};
const MISSING: StatusResult = { success: false, retryable: false, error: 'Job nie istnieje' };

function job(status: 'pending' | 'processing' | 'completed' | 'failed', expenseId: string | null = null) {
  return {
    success: true,
    job: { id: JOB_ID, status, error_message: null, expense_id: expenseId, extracted_data: null },
  } as StatusResult;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

beforeEach(() => {
  // `reset`, nie `clear`: kolejka `mockResolvedValueOnce` niezużyta w jednym
  // teście (np. gdy test pada w połowie) nie może przeciec do następnego.
  vi.resetAllMocks();
  vi.useFakeTimers();
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
  mocks.upload.mockResolvedValue({ success: true, ocrJobId: JOB_ID });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
  process.off('unhandledRejection', onUnhandled);
});

/** Renderuje przycisk i wgrywa zdjęcie — po tym trwa odpytywanie. */
async function renderAndUpload() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<CaptureButton />);
  });

  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File(['x'], 'paragon.jpg', { type: 'image/jpeg' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // Akcja wgrania odpowiada asynchronicznie; potem efekt odpytywania
  // pyta od razu (bez czekania na pierwszy takt).
  await act(async () => {});
  expect(mocks.upload).toHaveBeenCalledOnce();
  return host;
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function buttonText() {
  return host!.querySelector('button')!.textContent;
}

describe('CaptureButton — odpytywanie stanu odczytu (E16)', () => {
  it('retryable → pending → completed: przejście do wydatku, bez toastu błędu', async () => {
    mocks.getStatus
      .mockResolvedValueOnce(RETRYABLE)
      .mockResolvedValueOnce(job('pending'))
      .mockResolvedValueOnce(job('completed', EXPENSE_ID));

    await renderAndUpload();
    expect(mocks.getStatus).toHaveBeenCalledTimes(1);
    expect(mocks.getStatus).toHaveBeenLastCalledWith(JOB_ID);
    expect(buttonText()).toContain('Rozpoznaję');
    expect(mocks.toast.error).not.toHaveBeenCalled();

    await advance(2000);
    expect(mocks.getStatus).toHaveBeenCalledTimes(2);
    expect(buttonText()).toContain('Rozpoznaję');

    // Drugi odstęp to 3 s (sesja 11; dawniej znów 2 s).
    await advance(2999);
    expect(mocks.getStatus).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(mocks.getStatus).toHaveBeenCalledTimes(3);
    expect(mocks.router.push).toHaveBeenCalledOnce();
    expect(mocks.router.push).toHaveBeenCalledWith(`/expenses/${EXPENSE_ID}`);
    expect(mocks.toast.success).toHaveBeenCalledOnce();

    // Po sukcesie koniec: ani kolejnych pytań, ani toastu o przekroczeniu czasu.
    await advance(70_000);
    expect(mocks.getStatus).toHaveBeenCalledTimes(3);
    expect(mocks.toast.error).not.toHaveBeenCalled();
    expect(buttonText()).toContain('Dodaj wydatek');
  });

  it('retryable: false → jeden toast z błędem i koniec odpytywania', async () => {
    mocks.getStatus.mockResolvedValue(MISSING);

    await renderAndUpload();
    expect(mocks.toast.error).toHaveBeenCalledOnce();
    expect(mocks.toast.error).toHaveBeenCalledWith('Job nie istnieje');
    expect(buttonText()).toContain('Dodaj wydatek');

    await advance(70_000);
    expect(mocks.getStatus).toHaveBeenCalledTimes(1);
    expect(mocks.toast.error).toHaveBeenCalledOnce();
    expect(mocks.router.push).not.toHaveBeenCalled();
  });

  it('odrzucona obietnica akcji → kolejne pytanie po 2 s, bez unhandled rejection', async () => {
    mocks.getStatus
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValueOnce(job('completed', EXPENSE_ID));

    await renderAndUpload();
    expect(mocks.getStatus).toHaveBeenCalledTimes(1);
    expect(mocks.toast.error).not.toHaveBeenCalled();
    expect(buttonText()).toContain('Rozpoznaję');

    await advance(1999);
    expect(mocks.getStatus).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(mocks.getStatus).toHaveBeenCalledTimes(2);
    expect(mocks.router.push).toHaveBeenCalledOnce();
    expect(mocks.router.push).toHaveBeenCalledWith(`/expenses/${EXPENSE_ID}`);
    expect(mocks.toast.error).not.toHaveBeenCalled();

    // Node zgłasza nieobsłużone odrzucenie po opróżnieniu kolejki mikrozadań —
    // dajemy mu prawdziwy takt pętli zdarzeń.
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandled).toEqual([]);
  });

  it('ciągle retryable → po 60 s „Przekroczono czas oczekiwania” i koniec pytań', async () => {
    mocks.getStatus.mockResolvedValue(RETRYABLE);

    await renderAndUpload();
    await advance(58_000);
    // Pytanie od razu, potem po 2 s, 5 s, 9,5 s, 16,25 s, 26,25 s, 36,25 s,
    // 46,25 s, 56,25 s i ostatnie po 58 s, 2 s przed limitem: 10 pytań do
    // 58 s (przed sesją 11: co 2 s, 30 pytań).
    expect(mocks.getStatus).toHaveBeenCalledTimes(10);
    expect(mocks.toast.error).not.toHaveBeenCalled();
    expect(buttonText()).toContain('Rozpoznaję');

    await advance(2000);
    expect(mocks.toast.error).toHaveBeenCalledOnce();
    expect(mocks.toast.error).toHaveBeenCalledWith('Przekroczono czas oczekiwania');
    expect(buttonText()).toContain('Dodaj wydatek');

    const calls = mocks.getStatus.mock.calls.length;
    await advance(20_000);
    expect(mocks.getStatus).toHaveBeenCalledTimes(calls);
    expect(mocks.toast.error).toHaveBeenCalledOnce();
    expect(mocks.router.push).not.toHaveBeenCalled();
  });

  it('odczyt gotowy tuż przed limitem: ostatnie pytanie 2 s przed 60 s go widzi, bez komunikatu o czasie', async () => {
    // Pytania do 56,25 s widzą odczyt w toku; zadanie kończy się chwilę później.
    mocks.getStatus.mockResolvedValue(job('completed', EXPENSE_ID));
    for (let i = 0; i < 9; i++) mocks.getStatus.mockResolvedValueOnce(job('processing'));

    await renderAndUpload();
    await advance(57_999);
    expect(mocks.getStatus).toHaveBeenCalledTimes(9);
    expect(mocks.router.push).not.toHaveBeenCalled();

    await advance(1);
    // Bez tego pytania klient dostałby „Przekroczono czas oczekiwania”,
    // choć wydatek już powstał, i wgrałby zdjęcie drugi raz.
    expect(mocks.getStatus).toHaveBeenCalledTimes(10);
    expect(mocks.router.push).toHaveBeenCalledWith(`/expenses/${EXPENSE_ID}`);

    await advance(10_000);
    expect(mocks.toast.error).not.toHaveBeenCalled();
    expect(mocks.toast.success).toHaveBeenCalledOnce();
    expect(mocks.getStatus).toHaveBeenCalledTimes(10);
  });

  it('wisząca odpowiedź → jedno pytanie naraz; po odpowiedzi jedno przejście i jeden toast', async () => {
    let resolve!: (value: StatusResult) => void;
    mocks.getStatus.mockReturnValue(
      new Promise<StatusResult>((r) => {
        resolve = r;
      }),
    );

    await renderAndUpload();
    await advance(10_000);
    expect(mocks.getStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve(job('completed', EXPENSE_ID));
    });
    expect(mocks.router.push).toHaveBeenCalledOnce();
    expect(mocks.toast.success).toHaveBeenCalledOnce();
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it('odmontowanie w trakcie pytania → spóźnione „completed” nie przenosi i nie pokazuje toastu', async () => {
    let resolve!: (value: StatusResult) => void;
    mocks.getStatus.mockReturnValue(
      new Promise<StatusResult>((r) => {
        resolve = r;
      }),
    );

    await renderAndUpload();
    expect(mocks.getStatus).toHaveBeenCalledOnce();

    // Klient przechodzi na inną stronę, zanim serwer odpowie.
    act(() => root!.unmount());
    root = null;
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => {
      resolve(job('completed', EXPENSE_ID));
    });
    await advance(70_000);
    expect(mocks.router.push).not.toHaveBeenCalled();
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mocks.toast.error).not.toHaveBeenCalled();
    expect(mocks.getStatus).toHaveBeenCalledOnce();
  });

  it('odpowiedź wisi dłużej niż 60 s → jeden toast o czasie, spóźnione „completed” nic nie robi', async () => {
    let resolve!: (value: StatusResult) => void;
    mocks.getStatus.mockReturnValue(
      new Promise<StatusResult>((r) => {
        resolve = r;
      }),
    );

    await renderAndUpload();
    await advance(60_000);
    expect(mocks.toast.error).toHaveBeenCalledOnce();
    expect(mocks.toast.error).toHaveBeenCalledWith('Przekroczono czas oczekiwania');
    expect(buttonText()).toContain('Dodaj wydatek');
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => {
      resolve(job('completed', EXPENSE_ID));
    });
    expect(mocks.router.push).not.toHaveBeenCalled();
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalledOnce();
    expect(mocks.getStatus).toHaveBeenCalledOnce();
  });

  it('po zwolnieniu blokady pytamy dalej (wolna odpowiedź pending, potem completed)', async () => {
    let resolve!: (value: StatusResult) => void;
    mocks.getStatus
      .mockReturnValueOnce(
        new Promise<StatusResult>((r) => {
          resolve = r;
        }),
      )
      .mockResolvedValueOnce(job('completed', EXPENSE_ID));

    await renderAndUpload();
    await advance(5000);
    expect(mocks.getStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve(job('processing'));
    });
    expect(mocks.router.push).not.toHaveBeenCalled();

    // Takty po 2 s i 5 s przepadły (pytanie w toku); następny (9,5 s) pyta znowu.
    await advance(4499);
    expect(mocks.getStatus).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(mocks.getStatus).toHaveBeenCalledTimes(2);
    expect(mocks.router.push).toHaveBeenCalledOnce();
    expect(mocks.router.push).toHaveBeenCalledWith(`/expenses/${EXPENSE_ID}`);
  });

  it('rosnący odstęp: od razu, po 2 s, 3 s, 4,5 s, 6,75 s, potem co 10 s', async () => {
    mocks.getStatus.mockResolvedValue(job('processing'));

    await renderAndUpload();
    expect(mocks.getStatus).toHaveBeenCalledTimes(1);
    const gaps = [2000, 3000, 4500, 6750, 10_000, 10_000];
    for (const [i, gap] of gaps.entries()) {
      await advance(gap - 1);
      expect(mocks.getStatus).toHaveBeenCalledTimes(i + 1);
      await advance(1);
      expect(mocks.getStatus).toHaveBeenCalledTimes(i + 2);
    }
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });
});
