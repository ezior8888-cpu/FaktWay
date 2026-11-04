import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  prepare: vi.fn(), approve: vi.fn(), close: vi.fn(), sent: vi.fn(),
  state: [] as unknown[], refs: [] as Array<{ current: unknown }>, stateIndex: 0, refIndex: 0,
}));
vi.mock('@/app/actions/reminders', () => ({ prepareReminderAction: mock.prepare }));
vi.mock('@/app/actions/flo', () => ({ approveProposal: mock.approve }));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useId: () => 'reminder-test',
  useEffect: vi.fn(),
  useState: (initial: unknown) => {
    const index = mock.stateIndex++;
    if (!(index in mock.state)) mock.state[index] = initial;
    return [mock.state[index], (value: unknown) => {
      mock.state[index] = typeof value === 'function' ? value(mock.state[index]) : value;
    }];
  },
  useRef: (initial: unknown) => {
    const index = mock.refIndex++;
    mock.refs[index] ??= { current: initial };
    return mock.refs[index];
  },
}));
import { ReminderConsentDialog } from '@/components/reminders/reminder-consent-dialog';

const prepared = {
  success: true as const, proposalId: 'proposal-exact', approvalVersion: 'a'.repeat(64),
  expiresAt: '2026-09-23T12:30:00Z',
  preview: { from: 'Seller <seller@example.test>', to: 'buyer@example.test', replyTo: 'reply@example.test',
    subject: 'Exact subject', body: 'Exact visible message',
    attachment: { filename: 'Wezwanie.pdf', contentBase64: 'JVBERi0=' } },
};
function render() {
  mock.stateIndex = 0; mock.refIndex = 0;
  return ReminderConsentDialog({ source: { invoiceId: 'invoice-a', sourceProposalId: 'source-a', sourceVersion: 'b'.repeat(64) }, onClose: mock.close, onSent: mock.sent });
}
function elements(node: ReactNode): Array<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function field(name: string) {
  const item = elements(render()).find((item) => item.props.id === 'reminder-test-' + name);
  expect(item).toBeDefined();
  return item!.props;
}
function button(text: string) {
  const item = elements(render()).find((item) => item.props.children === text && typeof item.props.onClick === 'function');
  expect(item).toBeDefined();
  return item!.props;
}
function click(text: string) { (button(text).onClick as () => void)(); }
function change(name: string, value: string | boolean) {
  (field(name).onChange as (event: unknown) => void)({ target: typeof value === 'boolean' ? { checked: value } : { value } });
}
async function buildPreview() {
  click('Przygotuj podgląd');
  await vi.waitFor(() => expect(field('body').value).toBe(prepared.preview.body));
}
beforeEach(() => {
  vi.resetAllMocks(); mock.state = []; mock.refs = [];
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-23T12:00:00Z'));
  mock.prepare.mockResolvedValue(prepared); mock.approve.mockResolvedValue({ ok: true });
});
afterEach(() => vi.useRealTimers());

it('prepares without sending and shows the exact server envelope, text and PDF', async () => {
  expect(button('Zatwierdź i zleć wysyłkę').disabled).toBe(true);
  await buildPreview();
  expect(mock.prepare).toHaveBeenCalledWith({ invoiceId: 'invoice-a', sourceProposalId: 'source-a', sourceVersion: 'b'.repeat(64), recipientEmail: undefined });
  expect(mock.approve).not.toHaveBeenCalled();
  const nodes = elements(render());
  for (const text of [prepared.preview.from, prepared.preview.to, prepared.preview.replyTo, prepared.preview.subject]) {
    expect(nodes.some((item) => item.props.children === text)).toBe(true);
  }
  expect(nodes.some((item) => item.props.download === 'Wezwanie.pdf' && item.props.href === 'data:application/pdf;base64,JVBERi0=')).toBe(true);
  expect(field('recipient').value).toBe(prepared.preview.to);
  expect(button('Zatwierdź i zleć wysyłkę').disabled).toBe(true);
});
it('submits only the reviewed draft/version and exact edited text after explicit confirmation', async () => {
  await buildPreview(); change('body', 'My exact edited message'); change('confirm', true);
  click('Zatwierdź i zleć wysyłkę');
  await vi.waitFor(() => expect(mock.sent).toHaveBeenCalledOnce());
  expect(mock.approve).toHaveBeenCalledExactlyOnceWith('proposal-exact', 'a'.repeat(64), { editedBody: 'My exact edited message' });
  expect(mock.close).toHaveBeenCalledOnce();
});
it('invalidates the preview when recipient changes and resets confirmation after editing body', async () => {
  await buildPreview(); change('confirm', true); change('body', 'Changed');
  expect(field('confirm').checked).toBe(false);
  change('confirm', true); change('recipient', 'other@example.test');
  expect(elements(render()).some((item) => item.props.id === 'reminder-test-body')).toBe(false);
  expect(button('Zatwierdź i zleć wysyłkę').disabled).toBe(true);
  expect(mock.approve).not.toHaveBeenCalled();
});
it('guards same-tick double preparation and approval clicks', async () => {
  let resolvePrepare!: (value: typeof prepared) => void;
  mock.prepare.mockReturnValue(new Promise((resolve) => { resolvePrepare = resolve; }));
  const prepareClick = button('Przygotuj podgląd').onClick as () => void;
  prepareClick(); prepareClick();
  expect(mock.prepare).toHaveBeenCalledOnce(); resolvePrepare(prepared);
  await vi.waitFor(() => expect(field('body').value).toBe(prepared.preview.body));
  change('confirm', true);
  let resolveApprove!: (value: { ok: true }) => void;
  mock.approve.mockReturnValue(new Promise((resolve) => { resolveApprove = resolve; }));
  const approveClick = button('Zatwierdź i zleć wysyłkę').onClick as () => void;
  approveClick(); approveClick();
  expect(mock.approve).toHaveBeenCalledOnce(); resolveApprove({ ok: true });
  await vi.waitFor(() => expect(mock.sent).toHaveBeenCalledOnce());
});
it('does not approve an expired preview even before a timer rerenders the UI', async () => {
  await buildPreview(); change('confirm', true);
  vi.setSystemTime(new Date('2026-09-23T12:30:01Z'));
  click('Zatwierdź i zleć wysyłkę');
  expect(mock.approve).not.toHaveBeenCalled(); expect(field('confirm').disabled).toBe(true);
});
it('does not claim delivery when the operation is denied or its outcome is unknown', async () => {
  await buildPreview(); change('confirm', true);
  mock.approve.mockRejectedValue(new Error('private transport detail'));
  click('Zatwierdź i zleć wysyłkę');
  await vi.waitFor(() => expect(elements(render()).some((item) => item.props.role === 'alert')).toBe(true));
  expect(mock.sent).not.toHaveBeenCalled(); expect(mock.close).not.toHaveBeenCalled();
  expect(button('Zatwierdź i zleć wysyłkę').disabled).toBe(true);
  expect(elements(render()).some((item) => String(item.props.children).includes('private transport detail'))).toBe(false);
});

it('keeps a denied operation unconfirmed and requires a fresh preview', async () => {
  await buildPreview(); change('confirm', true);
  mock.approve.mockResolvedValue({ ok: false, reason: 'stale', message: 'Sprawdź nową wersję.' });
  click('Zatwierdź i zleć wysyłkę');
  await vi.waitFor(() => expect(elements(render()).some((item) => item.props.children === 'Sprawdź nową wersję.')).toBe(true));
  expect(mock.sent).not.toHaveBeenCalled();
  expect(button('Zatwierdź i zleć wysyłkę').disabled).toBe(true);
});
it('keeps preparation failures separate from approval and delivery', async () => {
  mock.prepare.mockResolvedValue({ success: false, error: 'Sprawdź adres.' });
  click('Przygotuj podgląd');
  await vi.waitFor(() => expect(elements(render()).some((item) => item.props.children === 'Sprawdź adres.')).toBe(true));
  expect(mock.approve).not.toHaveBeenCalled(); expect(mock.sent).not.toHaveBeenCalled();
});
it('przy zatwierdzeniu prosi o sprawdzenie aktualnego salda (poprawka Bartosza 21.10.2026)', async () => {
  // Zdanie przeszło tu z usuniętej noty nad kaflami „Po terminie”: saldo
  // sprawdza się w chwili zgody na wysyłkę, nie przy przeglądaniu listy.
  const SALDO = 'Przed zatwierdzeniem sprawdź aktualne saldo faktury — wpłata mogła już wpłynąć.';
  await buildPreview();
  expect(elements(render()).some((item) => item.props.children === SALDO)).toBe(true);
});
