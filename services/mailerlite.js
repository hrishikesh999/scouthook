'use strict';

const BASE_URL = 'https://connect.mailerlite.com/api';

function getConfig() {
  return {
    apiKey: process.env.MAILERLITE_API_KEY,
    groupFree: process.env.MAILERLITE_GROUP_FREE,
    groupPro: process.env.MAILERLITE_GROUP_PRO,
  };
}

async function apiRequest(method, path, body) {
  const { apiKey } = getConfig();
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204 || res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Mailerlite ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function upsertSubscriber(email, name, groupId) {
  const body = { email, fields: { name } };
  if (groupId) body.groups = [groupId];
  const data = await apiRequest('POST', '/subscribers', body);
  return data?.data?.id ?? null;
}

async function removeFromGroup(subscriberId, groupId) {
  await apiRequest('DELETE', `/subscribers/${subscriberId}/groups/${groupId}`);
}

async function addNewSubscriber(email, name) {
  const { apiKey, groupFree } = getConfig();
  if (!apiKey) return;
  try {
    await upsertSubscriber(email, name, groupFree || null);
  } catch (err) {
    console.error('[mailerlite] addNewSubscriber failed:', err.message);
  }
}

// Both solo and pro go to the same MailerLite group (MAILERLITE_GROUP_PRO).
// No separate Solo group — keeping one "paid" group simplifies email sequences.
async function upgradeSubscriberToPaid(email, name) {
  const { apiKey, groupFree, groupPro } = getConfig();
  if (!apiKey) return;
  try {
    const subscriberId = await upsertSubscriber(email, name, groupPro || null);
    if (subscriberId && groupFree) {
      await removeFromGroup(subscriberId, groupFree).catch(() => {});
    }
  } catch (err) {
    console.error('[mailerlite] upgradeSubscriberToPaid failed:', err.message);
  }
}

// Backward-compat alias — call sites that used upgradeSubscriberToPro still work.
const upgradeSubscriberToPro = upgradeSubscriberToPaid;

async function downgradeSubscriber(email, name) {
  const { apiKey, groupFree, groupPro } = getConfig();
  if (!apiKey) return;
  try {
    const subscriberId = await upsertSubscriber(email, name, groupFree || null);
    if (subscriberId && groupPro) {
      await removeFromGroup(subscriberId, groupPro).catch(() => {});
    }
  } catch (err) {
    console.error('[mailerlite] downgradeSubscriber failed:', err.message);
  }
}

// Backward-compat aliases
const addFreeSubscriber = addNewSubscriber;
const downgradeSubscriberToFree = downgradeSubscriber;

module.exports = { addFreeSubscriber, addNewSubscriber, upgradeSubscriberToPro, upgradeSubscriberToPaid, downgradeSubscriberToFree, downgradeSubscriber };
