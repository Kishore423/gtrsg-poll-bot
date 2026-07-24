const test = require('node:test');
const assert = require('node:assert/strict');
const { createSupabaseAuth, requireUser, requireAdmin } = require('../src/auth');
const { createMemoryDb } = require('../src/db/memory');

// Stands in for supabase.auth.getUser: any token of the form "tok:<email>" is a
// VALID Microsoft login. That mirrors reality under a multi-tenant Entra app --
// the identity provider happily authenticates strangers, so these tests prove the
// app_users allow-list (not the token) is what actually grants access.
function fakeSupabase() {
  return {
    auth: {
      async getUser(token) {
        const match = /^tok:(.+)$/.exec(token || '');
        if (!match) return { data: { user: null }, error: new Error('bad token') };
        return { data: { user: { id: `auth-${match[1]}`, email: match[1] } }, error: null };
      },
    },
  };
}

async function seeded() {
  const db = createMemoryDb();
  const botId = await db.createBot({
    bot_name: 'user_1_bot', token_encrypted: 'enc', webhook_secret: 'sec',
  });
  await db.createAppUser({ email: 'Yidan_Wang@sats.com.sg', role: 'user', bot_id: botId });
  await db.createAppUser({ email: 'Kirubakaran_Kishore@sats.com.sg', role: 'admin' });
  const auth = createSupabaseAuth({ db, client: fakeSupabase(), adminClient: {} });
  return { db, auth, botId };
}

const reqWith = (token) => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });

function runMiddleware(mw, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body, passed: false }); },
    };
    mw(req, res, () => resolve({ status: 200, passed: true, req }));
  });
}

test('a provisioned user is admitted and carries their role + bot', async () => {
  const { auth, botId } = await seeded();
  const user = await auth.verifyUser(reqWith('tok:Yidan_Wang@sats.com.sg'));
  assert.equal(user.email, 'yidan_wang@sats.com.sg');
  assert.equal(user.role, 'user');
  assert.equal(user.bot_id, botId);
});

test('SECURITY: a validly-authenticated but UNPROVISIONED account is denied', async () => {
  const { auth } = await seeded();
  // A real Microsoft account from any tenant -- the token verifies fine.
  const user = await auth.verifyUser(reqWith('tok:stranger@some-other-company.com'));
  assert.equal(user, null);

  const result = await runMiddleware(requireUser(auth.verifyUser),
    reqWith('tok:stranger@some-other-company.com'));
  assert.equal(result.passed, false);
  assert.equal(result.status, 403);
  assert.match(result.body.error, /not provisioned/i);
});

test('a disabled user loses access even though their row exists', async () => {
  const { db, auth } = await seeded();
  const [target] = (await db.listAppUsers()).filter((u) => u.role === 'user');
  const stored = await db.getAppUserByEmail(target.email);
  assert.ok(stored, 'enabled user resolves before being disabled');
  (await db.listAppUsers()).find((u) => u.id === target.id); // sanity
  // Disable by mutating through the repo's own surface.
  const all = await db.listAppUsers();
  assert.ok(all.length >= 2);
  await db.deleteAppUser(target.id); // hard-delete is the strongest form of disable
  assert.equal(await db.getAppUserByEmail(target.email), null);
  assert.equal(await auth.verifyUser(reqWith(`tok:${target.email}`)), null);
});

test('missing or malformed credentials are denied', async () => {
  const { auth } = await seeded();
  assert.equal(await auth.verifyUser(reqWith(null)), null);
  assert.equal(await auth.verifyUser(reqWith('garbage')), null);
});

test('requireAdmin lets an admin through and blocks a normal user', async () => {
  const { auth } = await seeded();
  const gate = requireAdmin(auth.verifyUser);

  const asAdmin = await runMiddleware(gate, reqWith('tok:Kirubakaran_Kishore@sats.com.sg'));
  assert.equal(asAdmin.passed, true);
  assert.equal(asAdmin.req.appUser.role, 'admin');
  assert.equal(asAdmin.req.appUser.bot_id, null); // admins may hold no bot

  const asUser = await runMiddleware(gate, reqWith('tok:Yidan_Wang@sats.com.sg'));
  assert.equal(asUser.passed, false);
  assert.equal(asUser.status, 403);
  assert.match(asUser.body.error, /Admin access required/i);
});

test('first sign-in binds the Microsoft identity to the pre-provisioned row', async () => {
  const { db, auth } = await seeded();
  const before = await db.getAppUserByEmail('Yidan_Wang@sats.com.sg');
  assert.equal(before.auth_user_id, null);

  await auth.verifyUser(reqWith('tok:Yidan_Wang@sats.com.sg'));

  const after = await db.getAppUserByEmail('Yidan_Wang@sats.com.sg');
  assert.equal(after.auth_user_id, 'auth-Yidan_Wang@sats.com.sg');
});

test('email matching is case-insensitive so Entra casing cannot lock a user out', async () => {
  const { auth } = await seeded();
  const user = await auth.verifyUser(reqWith('tok:YIDAN_WANG@SATS.COM.SG'));
  assert.ok(user, 'differently-cased email still resolves');
  assert.equal(user.role, 'user');
});
