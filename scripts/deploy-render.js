#!/usr/bin/env node
/**
 * deploy-render.js — create the Render service from the terminal.
 *
 * Everything the dashboard form does, done over the API instead, so the
 * deployment is a thing in the repository rather than a sequence of clicks
 * nobody wrote down.
 *
 *   RENDER_API_KEY=rnd_... node scripts/deploy-render.js
 *
 * The Supabase credentials are read from .env and sent straight to Render.
 * They are never printed, never committed, and never passed as arguments —
 * arguments show up in `ps` for every other user on the machine.
 *
 * Re-running is safe: if a service with this name already exists it is found
 * rather than duplicated, and a fresh deploy is triggered.
 */

const fs = require('fs');
const path = require('path');

const API = 'https://api.render.com/v1';
const KEY = process.env.RENDER_API_KEY;

const NAME   = process.env.RENDER_SERVICE_NAME || 'solaris';
const REPO   = 'https://github.com/ANIRUK007/SOLARIS';
const BRANCH = process.env.RENDER_BRANCH || 'mobile';
// Singapore is the closest Render region to the fieldwork. Oregon adds about
// 200ms to every request from India, on a connection that may already be poor.
const REGION = process.env.RENDER_REGION || 'singapore';
// The free plan sleeps, and a sleeping instance drops the request that wakes
// it — that request is somebody's recording.
const PLAN   = process.env.RENDER_PLAN || 'starter';

if (!KEY) {
  console.error(`
Set RENDER_API_KEY first.

  Render dashboard, top-right avatar, Account Settings, API Keys,
  then "Create API Key".

  RENDER_API_KEY=rnd_... node scripts/deploy-render.js
`);
  process.exit(1);
}

// ── .env, for the two Supabase values ────────────────────────────────────────
function readEnv() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return {};

  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

async function api(method, endpoint, body) {
  const res = await fetch(API + endpoint, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}

  if (!res.ok) {
    const detail = (data && (data.message || data.error)) || text.slice(0, 300);
    throw new Error(`${method} ${endpoint} → ${res.status}: ${detail}`);
  }
  return data;
}

(async function main() {
  const env = readEnv();
  const url = process.env.SUPABASE_URL || env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be in .env or the environment.');
    process.exit(1);
  }

  // ── Who we are deploying as ────────────────────────────────────────────────
  const owners = await api('GET', '/owners?limit=20');
  if (!owners.length) throw new Error('That API key can see no Render account.');
  const owner = owners[0].owner;
  console.log(`Account     : ${owner.name || owner.email} (${owner.id})`);

  // ── Already there? ─────────────────────────────────────────────────────────
  const existing = (await api('GET', `/services?name=${encodeURIComponent(NAME)}&limit=20`))
    .map(row => row.service)
    .find(s => s.name === NAME);

  let service = existing;

  if (service) {
    console.log(`Service     : ${NAME} already exists (${service.id}) — redeploying`);
  } else {
    console.log(`Service     : creating ${NAME}`);
    console.log(`Repository  : ${REPO} @ ${BRANCH}`);
    console.log(`Region      : ${REGION}    Plan: ${PLAN}`);

    // Creation answers with the service wrapped alongside the deploy it
    // started on its own: { service: {...}, deployId }. Reading .id off the
    // envelope gets undefined, and the next call asks for service "undefined".
    const created = await api('POST', '/services', {
      type: 'web_service',
      name: NAME,
      ownerId: owner.id,
      repo: REPO,
      branch: BRANCH,
      autoDeploy: 'yes',
      serviceDetails: {
        // Docker, because the Dockerfile is the deployment: no build step, no
        // package registry needed, the image is the runtime plus the repo.
        env: 'docker',
        plan: PLAN,
        region: REGION,
        healthCheckPath: '/health',
        envSpecificDetails: { dockerfilePath: './Dockerfile', dockerContext: '.' },
      },
      envVars: [
        { key: 'SUPABASE_URL', value: url },
        { key: 'SUPABASE_SERVICE_KEY', value: key },
        // True here, and only here: Render really is a proxy. Set where it is
        // not, and anyone can spoof a header for a fresh rate-limit quota.
        { key: 'SOLARIS_TRUST_PROXY', value: 'true' },
        { key: 'SOLARIS_TIMEZONE', value: 'Asia/Kolkata' },
        { key: 'SOLARIS_OPEN_REGISTRATION', value: 'true' },
      ],
    });

    service = created.service || created;
  }

  const id = service.id;
  if (!id) throw new Error(`Render returned no service id: ${JSON.stringify(service).slice(0, 300)}`);

  // ── Deploy, and wait ───────────────────────────────────────────────────────
  const deploy = await api('POST', `/services/${id}/deploys`, { clearCache: 'do_not_clear' });
  console.log(`\nDeploy      : ${deploy.id}\nBuilding — this takes a few minutes.\n`);

  const done = new Set(['live', 'build_failed', 'update_failed', 'canceled', 'deactivated']);
  let last = '';

  for (let i = 0; i < 160; i++) {                 // ~20 minutes
    await new Promise(r => setTimeout(r, 7500));

    const status = (await api('GET', `/services/${id}/deploys/${deploy.id}`)).status;
    if (status !== last) { console.log(`  ${status}`); last = status; }
    if (!done.has(status)) continue;

    if (status !== 'live') {
      console.error(`\nDeploy ended as "${status}". The build log is at:`);
      console.error(`  https://dashboard.render.com/web/${id}/deploys/${deploy.id}`);
      process.exit(1);
    }

    const live = await api('GET', `/services/${id}`);
    console.log(`\nLive at     : ${live.serviceDetails.url}`);
    console.log(`Dashboard   : https://dashboard.render.com/web/${id}`);
    console.log(`\nCheck it:     curl ${live.serviceDetails.url}/health`);
    return;
  }

  console.error('Still building after 20 minutes. Check the dashboard:');
  console.error(`  https://dashboard.render.com/web/${id}`);
  process.exit(1);
})().catch(err => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
