// Route guards are identity-provider agnostic. The configured verifyUser
// function validates the signed Telegram session and resolves the app_users row.
function requireUser(verifyUser) {
  return async (req, res, next) => {
    try {
      const user = await verifyUser(req);
      if (!user) return res.status(401).json({ error: 'Authentication required' });
      req.appUser = user;
      return next();
    } catch (error) {
      console.error('Authentication failed:', error.message);
      return res.status(401).json({ error: 'Authentication required' });
    }
  };
}

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

module.exports = { requireUser, requireAdmin };
