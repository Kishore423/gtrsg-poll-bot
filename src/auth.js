const { createClient } = require('@supabase/supabase-js');

// Sign-in uses Supabase email OTP. Authentication grants nothing on its own:
// the `app_users` table is the authorisation boundary, and it must fail CLOSED
// -- no row (or a disabled row) means no access, full stop.
//
// `db` is the repository (memory or postgres) used to look the caller up by email.
function createSupabaseAuth({ url, anonKey, serviceRoleKey, db, client, adminClient } = {}) {
  const supabase = client || (url && anonKey
    ? createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
    : null);
  const admin = adminClient || (url && serviceRoleKey
    ? createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
    : null);

  function bearerToken(req) {
    const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    return match ? match[1] : null;
  }

  // Resolves the caller to a provisioned app user, or null. Returning null is what
  // every caller treats as "denied" -- there is deliberately no path that grants
  // access purely because the Supabase token was valid.
  async function verifyUser(req) {
    if (!supabase || !db) return null;
    const token = bearerToken(req);
    if (!token) return null;

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return null;

    // Email is the join key between the Supabase identity and the allow-list.
    const email = data.user.email;
    if (!email) return null;

    const appUser = await db.getAppUserByEmail(email);
    if (!appUser || appUser.enabled === false) return null;

    // Bind the Supabase Auth identity to the pre-provisioned row on first sign-in.
    if (!appUser.auth_user_id && db.setAppUserAuthId) {
      await db.setAppUserAuthId(appUser.id, data.user.id);
    }

    return {
      id: appUser.id,
      email: appUser.email,
      role: appUser.role,
      bot_id: appUser.bot_id || null,
      auth_user_id: data.user.id,
    };
  }

  async function refresh(refreshToken) {
    if (!supabase) throw new Error('Supabase Auth is not configured');
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
    if (error) throw error;
    return data.session;
  }

  async function sendOtp(email) {
    if (!supabase || !db) throw new Error('Supabase Auth is not configured');
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const appUser = await db.getAppUserByEmail(normalizedEmail);
    if (!appUser || appUser.enabled === false) {
      const error = new Error('Your account is not provisioned for this app. Ask an admin to add you.');
      error.statusCode = 403;
      throw error;
    }

    const { error } = await supabase.auth.signInWithOtp({
      email: normalizedEmail,
      options: { shouldCreateUser: true },
    });
    if (error) throw error;
    return { email: normalizedEmail };
  }

  async function verifyOtp(email, token) {
    if (!supabase || !db) throw new Error('Supabase Auth is not configured');
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const appUser = await db.getAppUserByEmail(normalizedEmail);
    if (!appUser || appUser.enabled === false) {
      const error = new Error('Your account is not provisioned for this app. Ask an admin to add you.');
      error.statusCode = 403;
      throw error;
    }

    const { data, error } = await supabase.auth.verifyOtp({
      email: normalizedEmail,
      token: String(token || '').trim(),
      type: 'email',
    });
    if (error) throw error;
    return data.session;
  }

  return { verifyUser, refresh, sendOtp, verifyOtp };
}

// Any provisioned user.
function requireUser(verifyUser) {
  return async (req, res, next) => {
    try {
      const user = await verifyUser(req);
      if (!user) {
        return res.status(403).json({
          error: 'Your account is not provisioned for this app. Ask an admin to add you.',
        });
      }
      req.appUser = user;
      return next();
    } catch (error) {
      console.error('Authentication failed:', error.message);
      return res.status(401).json({ error: 'Authentication required' });
    }
  };
}

// Admin-only. Runs the same lookup then checks role, so a non-admin can never reach
// an admin route even with a perfectly valid Supabase session.
function requireAdmin(verifyUser) {
  const gate = requireUser(verifyUser);
  return (req, res, next) =>
    gate(req, res, () => {
      if (req.appUser?.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
      }
      return next();
    });
}

module.exports = { createSupabaseAuth, requireUser, requireAdmin };
