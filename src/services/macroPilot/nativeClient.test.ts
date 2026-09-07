import { describe, expect, it } from 'bun:test';
import {
  MacroPilotNativeClient,
  PilotClientError,
  type PilotClientDependencies,
} from './nativeClient';

const jsonResponse = (data: unknown, status = 200, url = ''): Response => {
  const response = new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'request:server:0001' },
  });
  if (url) Object.defineProperty(response, 'url', { value: url });
  return response;
};

const account = {
  contract_version: '1.0' as const,
  type: 'account' as const,
  account_id: 'account:github:583231',
  identity: { provider: 'github' as const, subject: '583231', login: 'octocat' },
  revision: 1,
};

const session = {
  contract_version: '1.0' as const,
  type: 'device_session' as const,
  ref: {
    type: 'session' as const,
    account_id: account.account_id,
    session_id: 'session:desktop:01J8T',
  },
  device_id: 'device:desktop:01J8T',
  state: 'active' as const,
  issued_at: '2026-09-06T10:00:00Z',
  expires_at: '2026-10-06T10:00:00Z',
  revision: 1,
};

const validSecret = (byte: number): string =>
  Buffer.alloc(32, byte).toString('base64url');

const createHarness = (responses: Array<Response | Error>) => {
  const values: Record<string, unknown> = {};
  const secrets = new Map<string, string>();
  const events: string[] = [];
  const requests: Array<{ url: string; init: RequestInit & { maxRedirections?: number } }> = [];
  let randomCall = 0;
  const scopeKey = (scope: { kind: string; resource_id: string }) => `${scope.kind}:${scope.resource_id}`;
  const dependencies: PilotClientDependencies = {
    fetch: (async (input, init) => {
      requests.push({ url: String(input), init: init || {} });
      events.push(`fetch:${String(input)}`);
      const response = responses.shift();
      if (!response) throw new Error('No fake response');
      if (response instanceof Error) throw response;
      return response;
    }) as PilotClientDependencies['fetch'],
    getStateSnapshot: async () => ({ schemaVersion: 1, values }),
    setStateValue: async (key, value) => {
      values[key] = structuredClone(value);
      events.push(`state:${key}`);
      return { schemaVersion: 1, values };
    },
    secretRead: async (scope) => secrets.get(scopeKey(scope)) ?? null,
    secretWrite: async (scope, secret) => {
      secrets.set(scopeKey(scope), secret);
      events.push(`secret:${scope.kind}`);
    },
    secretDelete: async (scope) => {
      secrets.delete(scopeKey(scope));
      events.push(`delete:${scope.kind}`);
    },
    randomBytes: (size) => new Uint8Array(size).fill(++randomCall),
    sha256: async () => new Uint8Array(32).fill(9),
    now: () => new Date('2026-09-06T10:00:00Z'),
  };
  return { client: new MacroPilotNativeClient(dependencies), dependencies, values, secrets, events, requests };
};

describe('MacroPilotNativeClient', () => {
  it('écrit le secret de claim avant de créer la tentative et ne persiste aucun secret', async () => {
    const pollSecret = validSecret(7);
    const harness = createHarness([
      jsonResponse({
        transport_version: '1.0',
        attempt_id: 'attempt:server:01J8T',
        poll_secret: pollSecret,
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://github.com/login/device',
        expires_at: '2026-09-06T10:10:00Z',
        interval: 2,
      }, 201),
    ]);

    await harness.client.initialize();
    const attempt = await harness.client.connect('https://pilot.example.com', 'Studio Mac');

    expect(attempt.interval).toBe(5);
    expect(harness.events.indexOf('secret:claim_secret')).toBeLessThan(
      harness.events.findIndex((event) => event.startsWith('fetch:')),
    );
    const request = harness.requests[0];
    expect(request.url).toBe('https://pilot.example.com/pilot/v1/auth/attempts');
    expect(request.init.maxRedirections).toBe(0);
    expect(JSON.parse(String(request.init.body))).toMatchObject({
      transport_version: '1.0',
      client_kind: 'desktop',
      device_label: 'Studio Mac',
      claim_challenge: validSecret(9),
    });
    expect(JSON.stringify(harness.values)).not.toContain(pollSecret);
    expect(JSON.stringify(harness.values)).not.toContain(validSecret(2));
  });

  it('attend la confirmation du compte avant de réclamer et déplace le jeton dans le coffre', async () => {
    const pollSecret = validSecret(7);
    const sessionSecret = validSecret(8);
    const harness = createHarness([
      jsonResponse({
        transport_version: '1.0', attempt_id: 'attempt:server:01J8T', poll_secret: pollSecret,
        user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device',
        expires_at: '2026-09-06T10:10:00Z', interval: 5,
      }, 201),
      jsonResponse({ transport_version: '1.0', status: 'identified', account }),
      jsonResponse({ transport_version: '1.0', account, device_session: session, session_token: sessionSecret }),
    ]);

    await harness.client.initialize();
    await harness.client.connect('https://pilot.example.com', 'Studio Mac');
    expect(await harness.client.pollAuth()).toEqual(account);
    expect(harness.client.getState().status).toBe('confirming_account');
    await expect(harness.client.confirmAccount('account:wrong')).rejects.toMatchObject({
      code: 'invalid_configuration',
    });

    await harness.client.confirmAccount(account.account_id);

    expect(harness.client.getState()).toMatchObject({ status: 'connected', account, deviceSession: session, attempt: null });
    expect([...harness.secrets.entries()]).toContainEqual([
      `session_token:${session.ref.session_id}`,
      sessionSecret,
    ]);
    expect([...harness.secrets.keys()].some((key) => key.startsWith('claim_secret:'))).toBe(false);
    expect([...harness.secrets.keys()].some((key) => key.startsWith('poll_secret:'))).toBe(false);
    expect(JSON.stringify(harness.values)).not.toContain(sessionSecret);
  });

  it('ajoute les preuves producteur sans les exposer et refuse les redirections', async () => {
    const pollSecret = validSecret(7);
    const sessionSecret = validSecret(8);
    const instanceSecret = validSecret(10);
    const instance = {
      contract_version: '1.0', type: 'instance', ref: { type: 'instance', instance_id: 'instance:studio' },
      label: 'Studio Mac', connection_state: 'reachable', supported_contract_versions: ['1.0'], revision: 1,
    };
    const access = {
      contract_version: '1.0', type: 'instance_access',
      ref: { type: 'instance_access', account_id: account.account_id, session_id: session.ref.session_id, instance_id: 'instance:studio' },
      state: 'granted', permissions: ['supervise'], granted_at: '2026-09-06T10:00:00Z', revision: 1,
    };
    const harness = createHarness([
      jsonResponse({ transport_version: '1.0', attempt_id: 'attempt:server:01J8T', poll_secret: pollSecret, user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_at: '2026-09-06T10:10:00Z', interval: 5 }, 201),
      jsonResponse({ transport_version: '1.0', status: 'identified', account }),
      jsonResponse({ transport_version: '1.0', account, device_session: session, session_token: sessionSecret }),
      jsonResponse({ transport_version: '1.0', instance, instance_access: access }, 201),
      jsonResponse({ requests: [] }),
      jsonResponse({}, 200, 'https://other.example/pilot/v1/me'),
    ]);

    await harness.client.initialize();
    await harness.client.connect('https://pilot.example.com', 'Studio Mac');
    await harness.client.pollAuth();
    await harness.client.confirmAccount(account.account_id);
    await harness.client.createOrAttachInstance({ label: 'Studio Mac' });
    const instanceEntry = [...harness.secrets.entries()].find(([key]) => key.startsWith('instance_key:'))!;
    harness.secrets.set(instanceEntry[0], instanceSecret);
    await harness.client.listAccessRequests();

    const headers = new Headers(harness.requests.at(-1)!.init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${sessionSecret}`);
    expect(headers.get('x-instance-key')).toBe(instanceSecret);
    expect(headers.get('x-request-id')).toMatch(/^request:/);
    await expect(harness.client.request('GET', '/me')).rejects.toBeInstanceOf(PilotClientError);
    await expect(harness.client.request('GET', 'https://evil.example')).rejects.toMatchObject({
      code: 'invalid_configuration',
    });
  });

  it('borne les réponses avant le décodage JSON', async () => {
    const harness = createHarness([
      new Response('x', { status: 200, headers: { 'content-length': '1048577' } }),
    ]);
    await harness.client.initialize();
    await expect(harness.client.connect('http://pilot.example.com', 'Studio Mac')).rejects.toMatchObject({
      code: 'invalid_configuration',
    });
    await harness.client.connect('https://pilot.example.com', 'Studio Mac').catch((error) => {
      expect(error).toMatchObject({ code: 'response_too_large' });
    });
  });

  it('conserve la tentative après une panne de persistance de session et permet son rejeu', async () => {
    const claim = { transport_version: '1.0', account, device_session: session, session_token: validSecret(8) };
    const harness = createHarness([
      jsonResponse({ transport_version: '1.0', attempt_id: 'attempt:server:01J8T', poll_secret: validSecret(7), user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_at: '2026-09-06T10:10:00Z', interval: 5 }, 201),
      jsonResponse({ transport_version: '1.0', status: 'identified', account }),
      jsonResponse(claim), jsonResponse(claim),
    ]);
    await harness.client.initialize();
    await harness.client.connect('https://pilot.example.com', 'Studio Mac');
    await harness.client.pollAuth();
    const persist = harness.dependencies.setStateValue;
    harness.dependencies.setStateValue = async (key, value) => {
      if ((value as { deviceSession?: unknown }).deviceSession) throw new Error('metadata unavailable');
      return persist(key, value);
    };
    await expect(harness.client.confirmAccount(account.account_id)).rejects.toMatchObject({ code: 'vault_unavailable' });
    expect([...harness.secrets.keys()].map((key) => key.split(':')[0]).sort()).toEqual(['claim_secret', 'poll_secret']);
    harness.dependencies.setStateValue = persist;
    const restarted = new MacroPilotNativeClient(harness.dependencies);
    await restarted.initialize();
    expect(restarted.getState().attempt?.identifiedAccount).toEqual(account);
    await restarted.confirmAccount(account.account_id);
    expect(restarted.getState()).toMatchObject({ deviceSession: session, attempt: null, status: 'connected' });
    expect([...harness.secrets.keys()]).toEqual([`session_token:${session.ref.session_id}`]);
  });

  it('libère le formulaire de connexion si le relais refuse une ancienne tentative', async () => {
    const harness = createHarness([
      jsonResponse({ transport_version: '1.0', attempt_id: 'attempt:server:01J8T', poll_secret: validSecret(7), user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_at: '2026-09-06T10:10:00Z', interval: 5 }, 201),
      jsonResponse({ transport_version: '1.0', status: 'identified', account }),
      jsonResponse({ code: 'unauthorized' }, 401),
    ]);
    await harness.client.initialize();
    await harness.client.connect('https://pilot.example.com', 'Studio Mac');
    await harness.client.pollAuth();
    await expect(harness.client.confirmAccount(account.account_id)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(harness.client.getState()).toMatchObject({ attempt: null, deviceSession: null, status: 'signed_out' });
    expect(harness.secrets.size).toBe(0);
  });

  it('conserve la session durable et reprend le nettoyage des secrets au redémarrage', async () => {
    const harness = createHarness([
      jsonResponse({ transport_version: '1.0', attempt_id: 'attempt:server:01J8T', poll_secret: validSecret(7), user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_at: '2026-09-06T10:10:00Z', interval: 5 }, 201),
      jsonResponse({ transport_version: '1.0', status: 'identified', account }),
      jsonResponse({ transport_version: '1.0', account, device_session: session, session_token: validSecret(8) }),
      jsonResponse({ transport_version: '1.0', account, device_session: session }),
    ]);
    await harness.client.initialize();
    await harness.client.connect('https://pilot.example.com', 'Studio Mac');
    await harness.client.pollAuth();
    const remove = harness.dependencies.secretDelete;
    harness.dependencies.secretDelete = async () => { throw new Error('vault unavailable'); };
    await harness.client.confirmAccount(account.account_id);
    expect(harness.client.getState()).toMatchObject({ status: 'connected', deviceSession: session, attempt: null });
    expect(harness.secrets.size).toBe(3);
    harness.dependencies.secretDelete = remove;
    const restarted = new MacroPilotNativeClient(harness.dependencies);
    await restarted.initialize();
    expect(restarted.getState()).toMatchObject({ status: 'connected', deviceSession: session, attempt: null });
    expect([...harness.secrets.keys()]).toEqual([`session_token:${session.ref.session_id}`]);
  });

  it('nettoie les deux secrets si la persistance de la tentative échoue', async () => {
    const harness = createHarness([
      jsonResponse({ transport_version: '1.0', attempt_id: 'attempt:server:01J8T', poll_secret: validSecret(7), user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_at: '2026-09-06T10:10:00Z', interval: 5 }, 201),
    ]);
    await harness.client.initialize();
    const persist = harness.dependencies.setStateValue;
    harness.dependencies.setStateValue = async (key, value) => {
      if ((value as { attempt?: unknown }).attempt) throw new Error('metadata unavailable');
      return persist(key, value);
    };
    await expect(harness.client.connect('https://pilot.example.com', 'Studio Mac')).rejects.toMatchObject({ code: 'vault_unavailable' });
    expect(harness.secrets.size).toBe(0);
    expect(harness.client.getState().attempt).toBeNull();
    await expect(harness.client.pollAuth()).rejects.toMatchObject({ code: 'invalid_configuration' });
    const restarted = new MacroPilotNativeClient(harness.dependencies);
    await restarted.initialize();
    expect(restarted.getState().attempt).toBeNull();
  });

  it('nettoie la clé de création si son identifiant ne peut pas être persisté', async () => {
    const harness = createHarness([
      jsonResponse({ transport_version: '1.0', attempt_id: 'attempt:server:01J8T', poll_secret: validSecret(7), user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_at: '2026-09-06T10:10:00Z', interval: 5 }, 201),
      jsonResponse({ transport_version: '1.0', status: 'identified', account }),
      jsonResponse({ transport_version: '1.0', account, device_session: session, session_token: validSecret(8) }),
    ]);
    await harness.client.initialize();
    await harness.client.connect('https://pilot.example.com', 'Studio Mac');
    await harness.client.pollAuth();
    await harness.client.confirmAccount(account.account_id);
    const persist = harness.dependencies.setStateValue;
    harness.dependencies.setStateValue = async (key, value) => {
      if ((value as { instanceCreationId?: unknown }).instanceCreationId) throw new Error('metadata unavailable');
      return persist(key, value);
    };
    await expect(harness.client.createOrAttachInstance({ label: 'Studio Mac' })).rejects.toThrow('metadata unavailable');
    expect([...harness.secrets.keys()]).toEqual([`session_token:${session.ref.session_id}`]);
    expect(harness.requests.some(({ url }) => url.endsWith('/instances'))).toBe(false);
    expect(harness.client.getState().instance).toBeNull();
    // A second attempt must prepare a new key, rather than read an unpersisted identifier.
    await expect(harness.client.createOrAttachInstance({ label: 'Studio Mac' })).rejects.toThrow('metadata unavailable');
    expect(harness.events.filter((event) => event === 'secret:instance_key')).toHaveLength(2);
    expect([...harness.secrets.keys()]).toEqual([`session_token:${session.ref.session_id}`]);
  });

  it('réutilise la création et la clé préparées après une réponse perdue', async () => {
    const instance = {
      contract_version: '1.0', type: 'instance', ref: { type: 'instance', instance_id: 'instance:studio' },
      label: 'Studio Mac', connection_state: 'reachable', supported_contract_versions: ['1.0'], revision: 1,
    };
    const access = {
      contract_version: '1.0', type: 'instance_access',
      ref: { type: 'instance_access', account_id: account.account_id, session_id: session.ref.session_id, instance_id: 'instance:studio' },
      state: 'granted', permissions: ['supervise'], granted_at: '2026-09-06T10:00:00Z', revision: 1,
    };
    const responses: Array<Response | Error> = [
      jsonResponse({ transport_version: '1.0', attempt_id: 'attempt:server:01J8T', poll_secret: validSecret(7), user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_at: '2026-09-06T10:10:00Z', interval: 5 }, 201),
      jsonResponse({ transport_version: '1.0', status: 'identified', account }),
      jsonResponse({ transport_version: '1.0', account, device_session: session, session_token: validSecret(8) }),
      new Error('response lost'),
    ];
    const harness = createHarness(responses);
    await harness.client.initialize();
    await harness.client.connect('https://pilot.example.com', 'Studio Mac');
    await harness.client.pollAuth();
    await harness.client.confirmAccount(account.account_id);

    await expect(harness.client.createOrAttachInstance({ label: 'Studio Mac' })).rejects.toMatchObject({ code: 'offline' });
    responses.push(jsonResponse({ transport_version: '1.0', instance, instance_access: access }, 201));
    await harness.client.createOrAttachInstance({ label: 'A different label is ignored for the retry' });

    const creationRequests = harness.requests.filter(({ url }) => url.endsWith('/pilot/v1/instances'));
    expect(creationRequests).toHaveLength(2);
    expect(JSON.parse(String(creationRequests[0].init.body))).toEqual(JSON.parse(String(creationRequests[1].init.body)));
    expect(harness.events.filter((event) => event === 'secret:instance_key')).toHaveLength(1);
  });

  it('efface le jeton local quand la révocation ne peut pas être confirmée hors ligne', async () => {
    const responses: Array<Response | Error> = [
      jsonResponse({ transport_version: '1.0', attempt_id: 'attempt:server:01J8T', poll_secret: validSecret(7), user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_at: '2026-09-06T10:10:00Z', interval: 5 }, 201),
      jsonResponse({ transport_version: '1.0', status: 'identified', account }),
      jsonResponse({ transport_version: '1.0', account, device_session: session, session_token: validSecret(8) }),
      new Error('offline'),
    ];
    const harness = createHarness(responses);
    await harness.client.initialize();
    await harness.client.connect('https://pilot.example.com', 'Studio Mac');
    await harness.client.pollAuth();
    await harness.client.confirmAccount(account.account_id);

    await expect(harness.client.logout()).resolves.toEqual({ revocationConfirmed: false });

    expect(harness.client.getState()).toMatchObject({ status: 'signed_out', account: null, deviceSession: null });
    expect([...harness.secrets.keys()].some((key) => key.startsWith('session_token:'))).toBe(false);
  });

  it('reprend une requête authentifiée après une panne sans nouvelle connexion', async () => {
    const responses: Array<Response | Error> = [
      jsonResponse({ transport_version: '1.0', attempt_id: 'attempt:server:01J8T', poll_secret: validSecret(7), user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_at: '2026-09-06T10:10:00Z', interval: 5 }, 201),
      jsonResponse({ transport_version: '1.0', status: 'identified', account }),
      jsonResponse({ transport_version: '1.0', account, device_session: session, session_token: validSecret(8) }),
      new Error('network unavailable'),
      jsonResponse({ transport_version: '1.0', requests: [] }),
    ];
    const harness = createHarness(responses);
    await harness.client.initialize();
    await harness.client.connect('https://pilot.example.com', 'Studio Mac');
    await harness.client.pollAuth();
    await harness.client.confirmAccount(account.account_id);

    await expect(
      harness.client.request('GET', '/me', undefined, { authenticated: true }),
    ).rejects.toMatchObject({ code: 'offline' });
    expect(harness.client.getState().status).toBe('offline');

    await harness.client.request('GET', '/me', undefined, { authenticated: true });

    expect(harness.client.getState().status).toBe('connected');
    expect(harness.requests.filter(({ url }) => url.endsWith('/auth/attempts'))).toHaveLength(1);
    expect([...harness.secrets.keys()].some((key) => key.startsWith('session_token:'))).toBe(true);
  });

  it('refuse toute URI Device Flow différente de la page GitHub exacte', async () => {
    const invalidUris = [
      'http://github.com/login/device',
      'https://github.com/login/device?continue=phishing',
      'https://github.com/login/device#phishing',
      'https://github.com.evil.example/login/device',
      'https://www.github.com/login/device',
    ];

    for (const verificationUri of invalidUris) {
      const harness = createHarness([
        jsonResponse({
          transport_version: '1.0',
          attempt_id: 'attempt:server:01J8T',
          poll_secret: validSecret(7),
          user_code: 'ABCD-EFGH',
          verification_uri: verificationUri,
          expires_at: '2026-09-06T10:10:00Z',
          interval: 5,
        }, 201),
      ]);
      await harness.client.initialize();

      await expect(
        harness.client.connect('https://pilot.example.com', 'Studio Mac'),
      ).rejects.toMatchObject({ code: 'invalid_response' });

      expect(harness.client.getState().attempt).toBeNull();
      expect([...harness.secrets.keys()].some((key) => key.startsWith('claim_secret:'))).toBe(false);
      expect([...harness.secrets.keys()].some((key) => key.startsWith('poll_secret:'))).toBe(false);
    }
  });

  it('vide immédiatement la session quand une requête authentifiée apprend sa révocation', async () => {
    const sessionSecret = validSecret(8);
    const harness = createHarness([
      jsonResponse({ transport_version: '1.0', attempt_id: 'attempt:server:01J8T', poll_secret: validSecret(7), user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_at: '2026-09-06T10:10:00Z', interval: 5 }, 201),
      jsonResponse({ transport_version: '1.0', status: 'identified', account }),
      jsonResponse({ transport_version: '1.0', account, device_session: session, session_token: sessionSecret }),
      jsonResponse({
        contract_version: '1.0', type: 'error', request_id: 'request:server:0001',
        code: 'session_revoked', message: 'session_revoked', retryable: false,
      }, 401),
    ]);
    await harness.client.initialize();
    await harness.client.connect('https://pilot.example.com', 'Studio Mac');
    await harness.client.pollAuth();
    await harness.client.confirmAccount(account.account_id);

    await expect(
      harness.client.request('POST', '/instances/instance%3Astudio/deliveries/poll',
        { transport_version: '1.0' }, { authenticated: true }),
    ).rejects.toMatchObject({ code: 'session_revoked', status: 401 });

    expect(harness.client.getState()).toMatchObject({
      status: 'signed_out', account: null, deviceSession: null, instanceAccess: null,
    });
    expect([...harness.secrets.keys()].some((key) => key.startsWith('session_token:'))).toBe(false);
    expect(JSON.stringify(harness.values)).not.toContain(session.ref.session_id);
    const revokedRequestHeaders = new Headers(harness.requests.at(-1)!.init.headers);
    expect(revokedRequestHeaders.get('authorization')).toBe(`Bearer ${sessionSecret}`);
  });
  it('uses literal A1 colons in route identifiers without decoding path separators', async () => {
    const harness = createHarness([
      jsonResponse({}),
      jsonResponse({}),
    ]);
    await harness.client.initialize();
    // Configure without making an auth request; an existing local profile is enough.
    harness.values.macro_pilot_native_v1 = { configurationId: 'config:test', relayOrigin: 'https://pilot.example.com' };
    await harness.client.initialize();
    await harness.client.request('GET', '/instances/instance%3Astudio');
    await harness.client.request('GET', '/instances/instance%3astudio%2Fextra');
    expect(harness.requests[0].url).toBe('https://pilot.example.com/pilot/v1/instances/instance:studio');
    expect(harness.requests[1].url).toBe('https://pilot.example.com/pilot/v1/instances/instance:studio%2Fextra');
  });

});
