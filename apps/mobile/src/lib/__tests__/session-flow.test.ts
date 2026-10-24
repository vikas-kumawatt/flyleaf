// Beta bug (Oct 2026): a step after a successful login failing made the
// sign-in screen say the password was wrong. sessionFlow.ts: only the
// credentials call can fail a sign-in, and sign-out ends everything.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createSessionFlow, type SessionFlowDeps } from '../sessionFlow';
import { GuestManager } from '../guest';

type U = { id: string; emailVerified?: boolean };

function harness(overrides: Partial<SessionFlowDeps<U>> = {}) {
  const log: string[] = [];
  const state = { user: null as U | null, tokens: false, saved: null as U | null };
  const deps: SessionFlowDeps<U> = {
    login: async () => {
      state.tokens = true;
      return { user: { id: 'u1' } };
    },
    register: async () => {
      state.tokens = true;
      return { user: { id: 'u1' } };
    },
    logout: async () => {
      state.tokens = false;
      log.push('logout');
    },
    me: async () => ({ id: 'u1', emailVerified: true }),
    saveSessionUser: async (u) => {
      state.saved = u;
    },
    clearCache: () => log.push('clearCache'),
    setUser: (u) => {
      state.user = u;
    },
    migrateGuest: async () => {
      log.push('migrate');
    },
    cancelGuestMigration: () => log.push('cancelMigration'),
    resetTelemetry: () => log.push('resetTelemetry'),
    onStepError: (step) => log.push(`error:${step}`),
    ...overrides,
  };
  return { flow: createSessionFlow(deps), log, state };
}

describe('sign-in: only the credentials can fail it', () => {
  test('a refused login rejects with the server error, and nothing is started', async () => {
    const refused = Object.assign(new Error('Email or password is incorrect.'), { status: 401, code: 'invalid_credentials' });
    const { flow, state, log } = harness({ login: async () => Promise.reject(refused) });
    await assert.rejects(flow.signIn('a@b.co', 'pw'), (err) => err === refused);
    assert.equal(state.user, null);
    assert.deepEqual(log, []);
  });

  for (const failing of ['me', 'saveSessionUser', 'clearCache', 'setUser', 'migrateGuest'] as const) {
    test(`${failing} failing after a good login still signs in`, async () => {
      const boom = () => {
        throw new Error(`${failing} broke`);
      };
      const { flow, state, log } = harness({ [failing]: failing === 'clearCache' || failing === 'setUser' ? boom : async () => boom() });
      const started = await flow.signIn('a@b.co', 'pw');
      await started.guestMigration;
      assert.equal(state.tokens, true);
      assert.ok(log.includes(`error:${failing}`));
      if (failing !== 'setUser') assert.equal(state.user?.id, 'u1');
    });
  }

  test('/v1/me failing falls back to the login response user', async () => {
    const { flow, state } = harness({ me: async () => Promise.reject(new TypeError('Network request failed')) });
    const { user } = await flow.signIn('a@b.co', 'pw');
    assert.deepEqual(user, { id: 'u1' });
    assert.deepEqual(state.user, { id: 'u1' });
  });

  test('a sign-in that restored a deleted account says so; an ordinary one does not (LA-01)', async () => {
    assert.equal((await harness().flow.signIn('a@b.co', 'pw')).restored, false);
    const { flow } = harness({ login: async () => ({ user: { id: 'u1' }, restored: true }) });
    assert.equal((await flow.signIn('a@b.co', 'pw')).restored, true);
  });

  test('the guest migration does not hold the sign-in', async () => {
    let release!: () => void;
    const { flow, state } = harness({ migrateGuest: () => new Promise<void>((r) => (release = r)) });
    const started = await flow.signIn('a@b.co', 'pw'); // resolves while the migration is pending
    assert.equal(state.user?.id, 'u1');
    release();
    await started.guestMigration;
  });

  test('a throwing error reporter does not fail the sign-in either', async () => {
    const { flow, state } = harness({
      me: async () => Promise.reject(new Error('x')),
      onStepError: () => {
        throw new Error('reporter broke');
      },
    });
    await flow.signIn('a@b.co', 'pw');
    assert.equal(state.user?.id, 'u1');
  });
});

describe('sign-out ends the session even when the server is unreachable', () => {
  test('migration cancelled first, then logout, cache, telemetry, user', async () => {
    const { flow, log, state } = harness();
    await flow.signIn('a@b.co', 'pw');
    log.length = 0;
    await flow.signOut();
    assert.deepEqual(log, ['cancelMigration', 'logout', 'clearCache', 'resetTelemetry']);
    assert.equal(state.user, null);
  });

  test('a failing logout still clears the user, cache and telemetry', async () => {
    const { flow, log, state } = harness({ logout: async () => Promise.reject(new TypeError('Network request failed')) });
    await flow.signIn('a@b.co', 'pw');
    await flow.signOut();
    assert.ok(log.includes('error:logout'));
    assert.ok(log.includes('resetTelemetry'));
    assert.equal(state.user, null);
  });
});

describe('with the real guest shelf', () => {
  test('a migration that cannot reach the server keeps the books and the sign-in succeeds', async () => {
    const guest = new GuestManager();
    await guest.addBook({ id: 'w1', title: 'Piranesi', author_name: 'Susanna Clarke' });
    const down = Object.assign(new Error('Service Unavailable'), { status: 503 });
    const api = { reads: async () => [], setStatus: async () => Promise.reject(down) };
    const { flow, state } = harness({ migrateGuest: () => guest.migrateToServer(api), cancelGuestMigration: () => guest.cancelMigration() });
    const started = await flow.signIn('a@b.co', 'pw');
    await started.guestMigration;
    assert.equal(state.user?.id, 'u1');
    assert.equal(guest.getCount(), 1);
  });

  test('signing out mid-migration stops it; the next sign-in migrates the rest', async () => {
    const guest = new GuestManager();
    for (const id of ['a', 'b', 'c']) await guest.addBook({ id, title: id, author_name: 'A' });
    const sent: string[] = [];
    let gate!: () => void;
    const slow = {
      reads: async () => [],
      setStatus: async (workId: string) => {
        sent.push(workId);
        if (sent.length === 1) await new Promise<void>((r) => (gate = r));
      },
    };
    const first = guest.migrateToServer(slow);
    await new Promise((r) => setImmediate(r));
    guest.cancelMigration(); // sign-out while the first book is in flight
    gate();
    await first;
    assert.equal(sent.length, 1, 'nothing more is sent after sign-out');

    const fast = { reads: async () => [], setStatus: async (workId: string) => void sent.push(workId) };
    const second = await guest.migrateToServer(fast);
    assert.equal(guest.getCount(), 0);
    assert.equal(second.count, 2);
  });

  test('migrateToServer never rejects, even when the api object itself throws', async () => {
    const guest = new GuestManager();
    await guest.addBook({ id: 'w1', title: 't', author_name: 'a' });
    const broken = {
      reads: () => {
        throw new Error('not a promise');
      },
      setStatus: async () => {},
    } as unknown as Parameters<GuestManager['migrateToServer']>[0];
    assert.deepEqual(await guest.migrateToServer(broken), { count: 0, message: null });
    assert.equal(guest.getCount(), 1);
  });
});
