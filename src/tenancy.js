function isAdmin(user) {
  return user?.role === 'admin';
}

function scopeGroups(user) {
  if (!user || isAdmin(user)) return {};
  return { botId: user.bot_id || '__no_bot__' };
}

function canAccessGroup(user, group) {
  if (!group) return false;
  if (!user || isAdmin(user)) return true;
  return Boolean(user.bot_id) && String(group.bot_id) === String(user.bot_id);
}

function notFound(message = 'Group not found') {
  const error = new Error(message);
  error.statusCode = 404;
  return error;
}

async function assertGroupAccess(db, user, groupId) {
  let group = db.getTelegramGroup ? await db.getTelegramGroup(groupId) : null;
  if (!group && db.listTelegramGroups) {
    const groups = await db.listTelegramGroups();
    group = groups.find((item) => String(item.id) === String(groupId)) || null;
  }
  if (!user && !group && !db.getTelegramGroup && !db.listTelegramGroups) return { id: groupId };
  if (!canAccessGroup(user, group)) throw notFound();
  return group;
}

function filterRowsByUserBot(rows, user) {
  if (!user || isAdmin(user)) return rows;
  if (!user.bot_id) return [];
  return rows.filter((row) => String(row.bot_id) === String(user.bot_id));
}

module.exports = {
  scopeGroups,
  assertGroupAccess,
  canAccessGroup,
  filterRowsByUserBot,
};
