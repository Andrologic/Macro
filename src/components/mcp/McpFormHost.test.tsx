import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { McpInteractionRequest, McpInteractionResponse } from '../../types/generated/ipc';
import { McpFormHost, type FormHostPort } from '../../services/mcp/formHost';
import { Dialog } from '../ui/Dialog';

mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string, options?: Record<string, unknown>) =>
      Object.entries(options ?? {}).reduce((text, [name, value]) =>
        text.replaceAll(`{{${name}}}`, String(value)), fallback),
  }),
}));
const { McpFormHostView } = await import('./McpFormHost');

const request = (id: string, serverId: string, fieldName = 'name'): McpInteractionRequest => ({
  requestId: id,
  key: { serverId, projectId: null, projectIds: [], configGeneration: 4 },
  operationId: `operation-${serverId}`,
  expiresAtMs: Date.now() + 30_000,
  prompts: [{ id: 'prompt', request: {
    method: 'elicitation/create', params: { mode: 'form', message: 'Choose a display name', requestedSchema: {
      type: 'object', properties: {
        [fieldName]: { type: 'string', title: fieldName === 'name' ? 'Display name' : 'API key', minLength: 2, default: 'Ada' },
        role: { type: 'string', enum: ['reader', 'writer'], enumNames: ['Reader', 'Writer'] },
      }, required: [fieldName, 'role'],
    } },
  } }],
});

function setup() {
  let receive: ((request: McpInteractionRequest) => void) | null = null;
  const responses: McpInteractionResponse[] = [];
  const active = new Set<string>();
  const port: FormHostPort = {
    open: async (callback) => { receive = callback; return 'lease'; },
    close: async () => undefined,
    pending: async () => [...active],
    respond: async (_lease, response) => { responses.push(response); active.delete(response.requestId); },
  };
  return { host: new McpFormHost(port), responses, send: (value: McpInteractionRequest) => {
    active.add(value.requestId);
    receive?.(value);
  } };
}

const click = (label: string) => {
  const button = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes(label));
  expect(button).toBeDefined();
  button?.click();
};

describe('global MCP form dialog', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); await Promise.resolve(); });
    container.remove();
  });

  it('stays visible across parent view changes and requires review before sending edited values', async () => {
    const { host, send, responses } = setup();
    await act(async () => { root.render(<><span>Chat</span><McpFormHostView host={host} /></>); await Promise.resolve(); });
    await act(async () => { send(request('r1', 'alpha')); });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('alpha');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Choose a display name');
    expect((document.querySelector('input[type="text"]') as HTMLInputElement).value).toBe('Ada');
    expect(document.querySelector('button')?.textContent).not.toContain('Send reviewed values');
    await act(async () => { root.render(<><span>Architect</span><McpFormHostView host={host} /></>); });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('alpha');

    await act(async () => {
      const input = document.querySelector('input[type="text"]') as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'Grace');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const select = document.querySelector('select') as HTMLSelectElement;
      select.value = '1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => { click('Review values'); });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Grace');
    expect(responses).toHaveLength(0);
    await act(async () => { click('Send reviewed values'); await Promise.resolve(); });
    expect(responses).toMatchObject([{
      requestId: 'r1', operationId: 'operation-alpha', key: { serverId: 'alpha', configGeneration: 4 },
      answers: [{ id: 'prompt', action: 'accept', content: { name: 'Grace', role: 'writer' } }],
    }]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps an incoming form and its expiry error above an existing modal', async () => {
    const { host, send } = setup();
    const startedAt = 100_000;
    const clock = spyOn(Date, 'now').mockReturnValue(startedAt);
    const originalSetTimeout = globalThis.setTimeout;
    const expiryCallbacks: Array<() => void> = [];
    // Drive the host's actual deadline callback after inspecting the active dialog.
    const controlledTimeout = Object.assign((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === 25 && typeof callback === 'function') {
        expiryCallbacks.push(() => callback(...args));
        return originalSetTimeout(() => undefined, delay);
      }
      return originalSetTimeout(callback, delay, ...args);
    }, { __promisify__: originalSetTimeout.__promisify__ }) as typeof setTimeout;
    const timers = spyOn(globalThis, 'setTimeout').mockImplementation(controlledTimeout);
    try {
      await act(async () => {
        root.render(<>
          <Dialog title="Release notes" onClose={() => undefined}
            backdropClassName="fixed inset-0 z-[12000] flex items-center justify-center">
            <p>Release notes</p>
          </Dialog>
          <McpFormHostView host={host} />
        </>);
        await Promise.resolve();
      });
      await act(async () => { send({ ...request('r-over', 'alpha'), expiresAtMs: Date.now() + 25 }); });
      const roots = Array.from(document.querySelectorAll<HTMLElement>('[data-macro-dialog-root]'));
      const formRoot = roots.find((candidate) => candidate.textContent?.includes('MCP form request'));
      const releaseRoot = roots.find((candidate) => candidate.textContent?.includes('Release notes'));
      expect(formRoot?.style.zIndex).toBe('14000');
      expect(formRoot?.hasAttribute('inert')).toBe(false);
      expect(releaseRoot?.hasAttribute('inert')).toBe(true);
      expect(expiryCallbacks).toHaveLength(1);
      clock.mockReturnValue(startedAt + 25);
      await act(async () => { expiryCallbacks[0](); });
      const error = document.querySelector<HTMLElement>('[role="alert"]');
      expect(error?.textContent).toContain('expired');
      const noticeRoot = Array.from(document.querySelectorAll<HTMLElement>('[data-macro-dialog-root]'))
        .find((candidate) => candidate.textContent?.includes('expired'));
      expect(noticeRoot?.style.zIndex).toBe('14010');
      expect(noticeRoot?.hasAttribute('inert')).toBe(false);
      expect(releaseRoot?.hasAttribute('inert')).toBe(true);
      await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')?.click(); });
      expect(document.querySelector<HTMLElement>('[role="alert"]')).toBeNull();
      expect(releaseRoot?.hasAttribute('inert')).toBe(false);
    } finally {
      timers.mockRestore();
      clock.mockRestore();
    }
  });

  it('submits a required __proto__ field as an own JSON value after review', async () => {
    const { host, send, responses } = setup();
    await act(async () => { root.render(<McpFormHostView host={host} />); await Promise.resolve(); });
    const ownKeyRequest = request('own-key', 'alpha');
    ownKeyRequest.prompts = [{ id: 'prompt', request: {
      method: 'elicitation/create', params: { mode: 'form', message: 'Display name', requestedSchema:
        JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string","title":"Display name","default":"Ada"}},"required":["__proto__"]}'),
      },
    } }];
    await act(async () => { send(ownKeyRequest); });
    const input = document.querySelector<HTMLInputElement>('input[type="text"]');
    expect(input?.value).toBe('Ada');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'Grace');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { click('Review values'); });
    await act(async () => { click('Send reviewed values'); await Promise.resolve(); });
    const content = responses[0]?.answers[0]?.content as Record<string, unknown>;
    expect(Object.hasOwn(content, '__proto__')).toBe(true);
    expect(JSON.stringify(content)).toBe('{"__proto__":"Grace"}');
  });

  it('shows queued server identities and sends decline and cancel as separate actions', async () => {
    const { host, send, responses } = setup();
    await act(async () => { root.render(<McpFormHostView host={host} />); await Promise.resolve(); });
    await act(async () => { send(request('r1', 'alpha')); send(request('r2', 'beta')); });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('beta');
    await act(async () => { click('Decline'); await Promise.resolve(); });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('operation-beta');
    await act(async () => { click('Cancel'); await Promise.resolve(); });
    expect(responses.map((response) => response.answers[0]?.action)).toEqual(['decline', 'cancel']);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('does not solicit PIN or OTP fields named with underscores or camel case', async () => {
    const { host, send } = setup();
    await act(async () => { root.render(<McpFormHostView host={host} />); await Promise.resolve(); });
    for (const [index, name] of ['pin_code', 'pinCode', 'PINCode', 'PINCODE', 'otp_code', 'otpCode', 'otpValue'].entries()) {
      const pinRequest = request(`secret-${index}`, 'alpha');
      pinRequest.prompts = [{ id: 'prompt', request: {
        method: 'elicitation/create', params: { mode: 'form', message: 'Enter the code', requestedSchema: {
          type: 'object', properties: { [name]: { type: 'string', title: 'Entry' } }, required: [name],
        } },
      } }];
      await act(async () => { send(pinRequest); });
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Macro will not collect it here');
      expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Enter the code');
      expect(document.querySelector('[role="dialog"] input')).toBeNull();
      expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.includes('Review values'))).toBe(false);
      await act(async () => { click('Decline'); await Promise.resolve(); });
    }
  });

  it('does not render credential fields or offer accept for a secret-like form', async () => {
    const { host, send } = setup();
    await act(async () => { root.render(<McpFormHostView host={host} />); await Promise.resolve(); });
    await act(async () => { send(request('secret', 'alpha', 'api_key')); });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Macro will not collect it here');
    expect(document.querySelector('[role="dialog"] input')).toBeNull();
    expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.includes('Review values'))).toBe(false);
  });
});
