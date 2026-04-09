'use strict';

const express = require('express');
const router = express.Router();
const { getSetting, setSetting, getAllSettings } = require('../db');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

// Simple password check middleware for admin routes
function requireAdminPassword(req, res, next) {
  const provided = req.headers['x-admin-password'] || req.body?.admin_password;
  if (provided !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

// ---------------------------------------------------------------------------
// GET /admin/settings
// Returns all platform settings (values masked for sensitive keys)
// ---------------------------------------------------------------------------
router.get('/settings', requireAdminPassword, (req, res) => {
  const SENSITIVE_KEYS = [
    'anthropic_api_key',
    'linkedin_client_secret',
    'token_encryption_key',
  ];

  (async () => {
    const rows = await getAllSettings();
    const settings = rows.map(row => ({
      key: row.key,
      value: SENSITIVE_KEYS.includes(row.key) && row.value
        ? row.value.slice(0, 6) + '…' + row.value.slice(-4)
        : row.value,
      is_set: !!row.value,
    }));
    return res.json({ ok: true, settings });
  })().catch(err => {
    return res.status(500).json({ ok: false, error: err.message });
  });
});

// ---------------------------------------------------------------------------
// POST /admin/settings
// Set one or more platform settings
// Body: { admin_password, settings: { key: value, ... } }
// ---------------------------------------------------------------------------
router.post('/settings', requireAdminPassword, (req, res) => {
  const { settings } = req.body;

  if (!settings || typeof settings !== 'object') {
    return res.status(400).json({ ok: false, error: 'settings object required' });
  }

  const ALLOWED_KEYS = [
    'anthropic_api_key',
    'linkedin_client_id',
    'linkedin_client_secret',
    'linkedin_redirect_uri',
    'token_encryption_key',
    'redis_url',
    'scheduling_enabled',
  ];

  (async () => {
    const updated = [];
    for (const [key, value] of Object.entries(settings)) {
      if (!ALLOWED_KEYS.includes(key)) continue;
      await setSetting(key, value);
      updated.push(key);
    }
    return res.json({ ok: true, updated });
  })().catch(err => {
    return res.status(500).json({ ok: false, error: err.message });
  });
});

module.exports = router;
