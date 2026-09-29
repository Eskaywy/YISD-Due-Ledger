#!/usr/bin/env node
/**
 * scripts/create-admin.js — Bootstrap the FIRST super_admin account.
 *
 * Why: POST /api/auth/signup always creates role:'member' (routes/auth.js), and
 * the old admin seed is gated behind SEED_DEMO_DATA (Sprint 0). On a fresh
 * install the users table is empty, so there'd be no way into the admin portal.
 * This script provisions the initial admin out-of-band via the service-role key.
 *
 * Credentials are NEVER hardcoded — pass via env vars or CLI flags.
 *
 * Usage:
 *   ADMIN_USERNAME=admin ADMIN_PASSWORD='...' npm run admin:create
 *   node scripts/create-admin.js --username=admin --password='...'
 *
 * Flags:
 *   --username=, --password=   REQUIRED  (or ADMIN_USERNAME / ADMIN_PASSWORD)
 *   --email=, --name=          optional  (or ADMIN_EMAIL / ADMIN_NAME)
 *   --force          add/promote even if a super_admin already exists
 *   --must-change-password           force a password change on first sign-in
 *   --dry-run        validate + report what would happen, write nothing
 */
require('dotenv').config();

const bcrypt = require('bcryptjs');
const { randomUUID: uuidv4 } = require('crypto');

const argv = process.argv.slice(2);
const flag = (name) => {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
};

const username = String(flag('username') || process.env.ADMIN_USERNAME || '').trim().toLowerCase();
const email = String(flag('email') || process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const password = String(flag('password') || process.env.ADMIN_PASSWORD || '');
const name = String(flag('name') || process.env.ADMIN_NAME || 'Super Administrator').trim();
const force = !!flag('force');
const dryRun = !!flag('dry-run');
const mustChange = !!flag('must-change-password');

function fail(msg) {
  console.error('\n✗ create-admin: ' + msg + '\n');
  process.exit(1);
}

// ── Validation (runs before we load supabaseAdmin, which throws if env absent) ─
if (!username) fail('Missing username. Set ADMIN_USERNAME or pass --username=');
if (!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(username)) {
  fail('Username must be 3-30 chars — lowercase letters, digits, dot, dash or underscore ' +
       '(must start alphanumeric). Got: ' + username);
}
if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Email format is invalid: ' + email);
if (!password) fail('Missing password. Set ADMIN_PASSWORD or pass --password=');
if (password.length < 8) fail('Password must be at least 8 characters.');
if (password.length > 128) fail('Password must be 128 characters or fewer.');
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  fail('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from environment (.env).');
}
if (argv.some(a => a.startsWith('--password='))) {
  console.warn('! Prefer ADMIN_PASSWORD env var — CLI passwords land in shell history.');
}

const { supabase } = require('../supabaseAdmin');
const { generateSmartId } = require('../db');

const CANON = {
  region: { name: 'Lagos', code: 'LAG' },
  dept: { name: 'Media', code: 'MED' },
};

async function ensureRow(table, row) {
  const { data: byCode, error: selErr } = await supabase
    .from(table).select('*').eq('code', row.code).limit(1);
  if (selErr) throw selErr;
  if (byCode && byCode.length) return byCode[0];
  const { data: inserted, error: insErr } = await supabase
    .from(table)
    .insert({ id: uuidv4(), ...row, created_at: new Date().toISOString() })
    .select().single();
  if (insErr) {
    if (insErr.code === '23505') { // lost a concurrent race — re-read
      const { data: again } = await supabase.from(table).select('*').eq('code', row.code).limit(1);
      if (again?.length) return again[0];
    }
    throw insErr;
  }
  return inserted;
}

async function mintId(region, dept) {
  try {
    return await generateSmartId({
      regionName: region.name, regionCode: region.code,
      deptName: dept.name, deptCode: dept.code,
    });
  } catch (e) {
    // next_member_serial() RPC unavailable (schema not applied) — best-effort
    // fallback so bootstrap still works. Unique violation is retried by caller.
    const { count } = await supabase.from('users')
      .select('id', { count: 'exact', head: true });
    return `${region.code}-${dept.code}-${1000 + (count || 0) + 1}`;
  }
}

(async () => {
  try {
    // 1. Existing-admin guard
    const { data: admins, error: admErr } = await supabase
      .from('users').select('id, email, username, role').eq('role', 'super_admin');
    if (admErr) throw admErr;
    if (admins?.length && !force) {
      fail(`A super_admin already exists (${admins[0].username || admins[0].email}). ` +
           `Re-run with --force to add/promote another.`);
    }

    // 2. Existing username (the login handle) — or the email when one was supplied?
    const { data: existing, error: exErr } = await supabase
      .from('users').select('*').eq('username', username).limit(1);
    if (exErr) throw exErr;
    let found = existing?.[0];
    if (!found && email) {
      const { data: byEmail, error: emErr } = await supabase
        .from('users').select('*').eq('email', email).limit(1);
      if (emErr) throw emErr;
      found = byEmail?.[0];
    }

    if (dryRun) {
      const action = found ? (force ? 'PROMOTE' : 'BLOCK') : 'CREATE';
      console.log('\n(dry-run) would ' + action + ' super_admin:');
      console.log('  username:            ' + username);
      console.log('  email:               ' + (email || '(none)'));
      console.log('  name:                ' + name);
      console.log('  must_change_password: ' + mustChange);
      console.log('  existing super_admins: ' + (admins?.length || 0));
      console.log('  writes performed:     none\n');
      process.exit(0);
    }

    const hash = await bcrypt.hash(password, 10);
    const now = new Date().toISOString();

    // 3. Promote an existing member, or create a brand-new admin row.
    if (found) {
      if (found.role === 'super_admin' && !force) {
        fail('That account is already a super_admin.');
      }
      const { error: updErr } = await supabase.from('users').update({
        username, role: 'super_admin', is_active: true,
        password_hash: hash, must_change_password: mustChange, updated_at: now,
      }).eq('id', found.id);
      if (updErr) throw updErr;
      console.log('\n✓ Promoted existing user to super_admin: ' + username + '\n');
      return;
    }

    // 4. Ensure canonical region + department exist (Smart ID dependencies).
    const region = await ensureRow('regions', CANON.region);
    const dept = await ensureRow('departments', CANON.dept);

    let inserted = false;
    for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
      const userIdCode = await mintId(region, dept);
      const { error: insErr } = await supabase.from('users').insert({
        id: uuidv4(),
        user_id_code: userIdCode,
        full_name: name,
        first_name: name.split(' ')[0] || null,
        surname: name.split(' ').slice(1).join(' ') || null,
        username,
        email: email || null,
        password_hash: hash,
        position: 'Super Administrator',
        region_id: region.id,
        dept_code: dept.code,
        role: 'super_admin',
        is_active: true,
        must_change_password: mustChange,
        created_at: now,
        updated_at: now,
      });
      if (!insErr) {
        inserted = true;
        console.log('\n✓ super_admin created');
        console.log('  username:    ' + username);
        console.log('  email:       ' + (email || '(none)'));
        console.log('  member id:   ' + userIdCode);
        console.log('  region/dept: ' + region.code + ' / ' + dept.code);
        console.log('  force change on first login: ' + mustChange);
        console.log('\nSign in at /login with the credentials you supplied.\n');
      } else if (insErr.code === '23505') {
        // Duplicate username (race) or exhausted serial — re-check and stop.
        const { data: again } = await supabase.from('users')
          .select('id').eq('username', username).limit(1);
        if (again?.length) fail('That username was created concurrently. Re-run to promote it.');
        // else: serial collision → loop for a fresh serial
      } else {
        throw insErr;
      }
    }
    if (!inserted) fail('Could not mint a unique member ID after 3 attempts.');
  } catch (err) {
    console.error('\n✗ create-admin failed: ' + (err.message || err) + '\n');
    process.exit(1);
  }
})();

