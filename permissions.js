// AUTO-GENERATED action→permission-group map (145 zca-js APIs).
// Groups by danger level: read < send < interact < manage < destructive.
export const ACTION_GROUPS = ["read", "send", "interact", "manage", "destructive"];
export const DEFAULT_GROUPS = ["read", "send", "interact"];
export const ACTION_GROUP = {
  "acceptFriendRequest": "manage",
  "addGroupBlockedMember": "destructive",
  "addGroupDeputy": "manage",
  "addPollOptions": "interact",
  "addQuickMessage": "manage",
  "addReaction": "interact",
  "addUnreadMark": "manage",
  "addUserToGroup": "manage",
  "blockUser": "destructive",
  "blockViewFeed": "destructive",
  "changeAccountAvatar": "destructive",
  "changeFriendAlias": "manage",
  "changeGroupAvatar": "manage",
  "changeGroupName": "manage",
  "changeGroupOwner": "destructive",
  "createAutoReply": "manage",
  "createCatalog": "manage",
  "createGroup": "manage",
  "createNote": "interact",
  "createPoll": "interact",
  "createProductCatalog": "manage",
  "createReminder": "interact",
  "deleteAutoReply": "destructive",
  "deleteAvatar": "destructive",
  "deleteCatalog": "destructive",
  "deleteChat": "destructive",
  "deleteGroupInviteBox": "destructive",
  "deleteMessage": "destructive",
  "deleteProductCatalog": "destructive",
  "disableGroupLink": "destructive",
  "disperseGroup": "destructive",
  "editNote": "interact",
  "editReminder": "interact",
  "enableGroupLink": "manage",
  "fetchAccountInfo": "read",
  "findUser": "read",
  "findUserByUsername": "read",
  "forwardMessage": "send",
  "getAliasList": "read",
  "getAllFriends": "read",
  "getAllGroups": "read",
  "getArchivedChatList": "read",
  "getAutoDeleteChat": "read",
  "getAutoReplyList": "read",
  "getAvatarList": "read",
  "getAvatarUrlProfile": "read",
  "getBizAccount": "read",
  "getCatalogList": "read",
  "getCloseFriends": "read",
  "getContext": "read",
  "getCookie": "read",
  "getFriendBoardList": "read",
  "getFriendOnlines": "read",
  "getFriendRecommendations": "read",
  "getFriendRequestStatus": "read",
  "getFullAvatar": "read",
  "getGroupBlockedMember": "read",
  "getGroupChatHistory": "read",
  "getGroupInfo": "read",
  "getGroupInviteBoxInfo": "read",
  "getGroupInviteBoxList": "read",
  "getGroupLinkDetail": "read",
  "getGroupLinkInfo": "read",
  "getGroupMembersInfo": "read",
  "getHiddenConversations": "read",
  "getLabels": "read",
  "getListBoard": "read",
  "getListReminder": "read",
  "getMultiUsersByPhones": "read",
  "getMute": "read",
  "getOwnId": "read",
  "getPendingGroupMembers": "read",
  "getPinConversations": "read",
  "getPollDetail": "read",
  "getProductCatalogList": "read",
  "getQR": "read",
  "getQuickMessageList": "read",
  "getRelatedFriendGroup": "read",
  "getReminder": "read",
  "getReminderResponses": "read",
  "getSentFriendRequest": "read",
  "getSettings": "read",
  "getStickerCategoryDetail": "read",
  "getStickers": "read",
  "getStickersDetail": "read",
  "getUnreadMark": "read",
  "getUserInfo": "read",
  "inviteUserToGroups": "manage",
  "joinGroupInviteBox": "manage",
  "joinGroupLink": "manage",
  "keepAlive": "read",
  "lastOnline": "read",
  "leaveGroup": "destructive",
  "lockPoll": "interact",
  "parseLink": "send",
  "rejectFriendRequest": "manage",
  "removeFriend": "destructive",
  "removeFriendAlias": "manage",
  "removeGroupBlockedMember": "manage",
  "removeGroupDeputy": "manage",
  "removeQuickMessage": "destructive",
  "removeReminder": "destructive",
  "removeUnreadMark": "manage",
  "removeUserFromGroup": "destructive",
  "resetHiddenConversPin": "destructive",
  "reuseAvatar": "manage",
  "reviewPendingMemberRequest": "manage",
  "searchSticker": "read",
  "sendBankCard": "send",
  "sendCard": "send",
  "sendDeliveredEvent": "interact",
  "sendFriendRequest": "manage",
  "sendLink": "send",
  "sendMessage": "send",
  "sendReport": "send",
  "sendSeenEvent": "interact",
  "sendSticker": "send",
  "sendTypingEvent": "send",
  "sendVideo": "send",
  "sendVoice": "send",
  "setHiddenConversations": "manage",
  "setMute": "manage",
  "setPinnedConversations": "manage",
  "sharePoll": "interact",
  "unblockUser": "manage",
  "undo": "interact",
  "undoFriendRequest": "manage",
  "updateActiveStatus": "manage",
  "updateArchivedChatList": "manage",
  "updateAutoDeleteChat": "manage",
  "updateAutoReply": "manage",
  "updateCatalog": "manage",
  "updateGroupSettings": "manage",
  "updateHiddenConversPin": "destructive",
  "updateLabels": "manage",
  "updateLang": "destructive",
  "updateProductCatalog": "manage",
  "updateProfile": "destructive",
  "updateProfileBio": "destructive",
  "updateQuickMessage": "manage",
  "updateSettings": "destructive",
  "upgradeGroupToCommunity": "destructive",
  "uploadAttachment": "send",
  "uploadProductPhoto": "manage",
  "votePoll": "interact"
};

// Actions that expose the session's secrets (cookie, imei, secretKey). Anyone
// holding them owns the Zalo account, so they are never granted through a
// group — not even "all". The only way in is naming them explicitly in
// ZALO_ALLOWED_ACTIONS.
export const SENSITIVE_ACTIONS = ["getCookie", "getContext"];

const _truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? "").trim());
const _csv = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

/**
 * Build the action policy from environment-style settings.
 *
 *   ZALO_ALLOWED_ACTION_GROUPS  csv of groups, or "all"  (default read,send,interact)
 *   ZALO_ALLOW_DESTRUCTIVE      true to permit the destructive group (off even under "all")
 *   ZALO_ALLOWED_ACTIONS        csv of method names to ALWAYS allow (overrides groups)
 *   ZALO_DENIED_ACTIONS         csv of method names to ALWAYS deny (overrides everything)
 *
 * @param {Record<string,string|undefined>} env
 */
export function createPolicy(env = {}) {
  const rawGroups = String(env.ZALO_ALLOWED_ACTION_GROUPS || "").trim().toLowerCase();
  const groups = !rawGroups
    ? new Set(DEFAULT_GROUPS)
    : rawGroups === "all"
      ? new Set(ACTION_GROUPS)
      : new Set(_csv(rawGroups).filter((g) => ACTION_GROUPS.includes(g)));
  const allowDestructive = _truthy(env.ZALO_ALLOW_DESTRUCTIVE);
  if (!allowDestructive) groups.delete("destructive");
  const allowed = new Set(_csv(env.ZALO_ALLOWED_ACTIONS));
  const denied = new Set(_csv(env.ZALO_DENIED_ACTIONS));

  /** @returns {{ok: true} | {ok: false, reason: string}} */
  function check(method) {
    if (denied.has(method)) return { ok: false, reason: "explicitly denied (ZALO_DENIED_ACTIONS)" };
    if (allowed.has(method)) return { ok: true };
    if (SENSITIVE_ACTIONS.includes(method)) {
      return { ok: false, reason: "exposes session secrets; only allowed when listed in ZALO_ALLOWED_ACTIONS" };
    }
    const group = Object.hasOwn(ACTION_GROUP, method) ? ACTION_GROUP[method] : null;
    if (!group) return { ok: false, reason: `unknown action '${method}'` };
    if (group === "destructive" && !allowDestructive) {
      return { ok: false, reason: "destructive actions disabled (set ZALO_ALLOW_DESTRUCTIVE=true to enable)" };
    }
    if (!groups.has(group)) {
      return { ok: false, reason: `action group '${group}' not in ZALO_ALLOWED_ACTION_GROUPS` };
    }
    return { ok: true };
  }

  function describe() {
    const allowedActions = Object.keys(ACTION_GROUP).filter((m) => check(m).ok);
    return {
      groups: [...groups],
      allowDestructive,
      customAllow: [...allowed],
      customDeny: [...denied],
      sensitive: [...SENSITIVE_ACTIONS],
      allowedActionCount: allowedActions.length,
      totalActions: Object.keys(ACTION_GROUP).length,
      allowedActions,
    };
  }

  return { check, describe, groups, allowDestructive, allowed, denied };
}
