const express = require('express');
const bcrypt = require('bcryptjs');
const { randomUUID: uuidv4 } = require('crypto');
const { supabase, generateSmartId, findOrCreateDepartment, findOrCreateRegion } = require('../db');
const { authenticate, generateToken } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');

const router = express.Router();

// The users table already stores snake_case columns matching the API shape the
// frontend expects, so the row maps 1:1 (and never exposes password_hash).
const publicUser = (user, regionName = null, regionCode = null) => ({
  id: user.id,
  user_id_code: user.user_id_code ?? null,
  full_name: user.full_name ?? null,
  first_name: user.first_name ?? null,
  surname: user.surname ?? null,
  username: user.username ?? null,
  email: user.email ?? null,
  position: user.position ?? null,
  role_title: user.role_title ?? null,
  region_id: user.region_id ?? null,
  region_name: regionName,
  region_code: regionCode,
  dept_code: user.dept_code ?? null,
  role: user.role ?? 'member',
  is_active: user.is_active ?? true,
  must_change_password: user.must_change_password === true,
  created_at: user.created_at ?? null,
  updated_at: user.updated_at ?? null,
});

// Load a region's name/code by its id.
const getRegion = async (regionId) => {
  if (!regionId) return { regionName: null, regionCode: null };
  const { data, error } = await supabase.from('regions').select('*').eq('id', regionId).single();
  if (error || !data) return { regionName: null, regionCode: null };
  return { regionName: data.name ?? null, regionCode: data.code ?? null };
};

router.post('/login', async (req, res) => {
  try {
    // Accept an email, a dedicated username, or a Smart Ledger ID
    // (e.g. LAG-MED-1001). The admin signs in with username + password;
    // members normally use email or their Smart ID.
    const identifier = String(req.body.identifier ?? req.body.email ?? '').trim();
    const { password } = req.body;
    if (!identifier || !password) {
      return res.status(400).json({ error: 'Email, username or Smart ID and password required' });
    }

    const lower = identifier.toLowerCase();
    const upper = identifier.toUpperCase();

    let users = null;
    let error = null;
    if (identifier.includes('@')) {
      // Email path (members)
      ({ data: users, error } = await supabase
        .from('users').select('*')
        .eq('email', lower).eq('is_active', true).limit(1));
    } else {
      // Dedicated username first (stored lowercase), then Smart ID fallback.
      ({ data: users, error } = await supabase
        .from('users').select('*')
        .eq('username', lower).eq('is_active', true).limit(1));
      if (!error && !users?.length) {
        ({ data: users, error } = await supabase
          .from('users').select('*')
          .eq('user_id_code', upper).eq('is_active', true).limit(1));
      }
    }
    if (error) throw error;
    if (!users?.length) return res.status(401).json({ error: 'Invalid credentials' });

    const user = users[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    // Get region data
    const { regionName, regionCode } = await getRegion(user.region_id);

    const token = generateToken(user.id);
    res.json({ token, user: publicUser(user, regionName, regionCode) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Public list of regions (used by the signup form, no auth required)
router.get('/regions', async (req, res) => {
  try {
    const { data, error } = await supabase.from('regions').select('*').order('name');
    if (error) throw error;
    res.json((data || []).map(r => ({ id: r.id, name: r.name ?? null, code: r.code ?? null })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch regions' });
  }
});

// Public list of departments for the signup form; seeds the prototype's
// defaults (Information / Media) on first call so the dropdown is never empty.
router.get('/departments', async (req, res) => {
  try {
    let { data, error } = await supabase.from('departments').select('*').order('name');
    if (error) throw error;
    if (!data?.length) {
      const { error: seedErr } = await supabase.from('departments').insert(
        [{ name: 'Information', code: 'INF' }, { name: 'Media', code: 'MED' }]
          .map(d => ({ id: uuidv4(), ...d, created_at: new Date().toISOString() }))
      );
      if (seedErr) throw seedErr;
      const re = await supabase.from('departments').select('*').order('name');
      data = re.data;
    }
    res.json((data || []).map(d => ({ id: d.id, name: d.name ?? null, code: d.code ?? null })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch departments' });
  }
});

router.get('/me', authenticate, async (req, res) => {
  try {
    const { data: user, error } = await supabase.from('users').select('*').eq('id', req.user.id).single();
    if (error || !user) return res.status(404).json({ error: 'User not found' });

    const { regionName, regionCode } = await getRegion(user.region_id);
    res.json(publicUser(user, regionName, regionCode));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

router.post('/signup', async (req, res) => {
  try {
    // Prototype signup fields (signup.html): first name + surname, position
    // (Leader/Member), a free-text role, and department/region selects where
    // "Other" names a new entry that becomes a standard option for everyone.
    const {
      first_name, surname, full_name, email, password, position, role_title,
      region_id, region_name, dept_code, department_name,
    } = req.body;

    const fullName = `${String(first_name || '').trim()} ${String(surname || '').trim()}`.trim()
      || String(full_name || '').trim();
    const roleTitle = String(role_title || '').trim();
    const firstName = String(first_name || '').trim();
    const surName = String(surname || '').trim();
    const pos = String(position || '').trim();

    // Validate required fields
    if (!fullName || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password required' });
    }

    // Position is a controlled enum (approved plan §3.1): Leader | Member.
    if (pos && pos !== 'Leader' && pos !== 'Member') {
      return res.status(400).json({ error: 'Position must be Leader or Member' });
    }
    if (fullName.length < 2 || fullName.length > 120) {
      return res.status(400).json({ error: 'Name must be between 2 and 120 characters' });
    }
    if (roleTitle.length > 60) {
      return res.status(400).json({ error: 'Role must be 60 characters or fewer' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Check if email already exists
    const { data: existingEmail, error: emailErr } = await supabase
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase().trim())
      .limit(1);
    if (emailErr) throw emailErr;
    if (existingEmail?.length) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Create new user
    const userId = uuidv4();
    const passwordHash = await bcrypt.hash(password, 10);

    // Resolve the department: an explicit code picks an existing row, a raw
    // name (the prototype's "Other" path) is upserted for everyone.
    const dept = await findOrCreateDepartment(dept_code, department_name);
    if (!dept) return res.status(400).json({ error: 'Department is required' });

    // Same for the region; fall back to the seeded default (Lagos).
    let region = null;
    if (region_id || region_name) {
      region = await findOrCreateRegion(region_id, region_name);
    }
    if (!region) {
      const { data: defaults, error: defErr } = await supabase
        .from('regions')
        .select('*')
        .eq('code', 'LAG')
        .limit(1);
      if (defErr) throw defErr;
      region = defaults?.length ? defaults[0] : null;
    }
    if (!region) return res.status(400).json({ error: 'Region is required' });

    // Mint the Smart Ledger ID: REGION-DEPT-serial (e.g. LAG-MED-1001)
    const user_id_code = await generateSmartId({
      regionName: region.name,
      regionCode: region.code,
      deptName: dept.name,
      deptCode: dept.code,
    });

    const now = new Date().toISOString();
    const { error: insertErr } = await supabase.from('users').insert({
      id: userId,
      user_id_code,
      full_name: fullName,
      first_name: firstName || fullName.split(' ')[0] || null,
      surname: surName || fullName.split(' ').slice(1).join(' ') || null,
      role_title: roleTitle || null,
      email: email.toLowerCase().trim(),
      password_hash: passwordHash,
      position: pos || null,
      region_id: region.id,
      dept_code: dept.code,
      role: 'member',
      is_active: true,
      created_at: now,
      updated_at: now,
    });
    if (insertErr) throw insertErr;

    // Auto login after signup
    const { data: user, error: fetchErr } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .single();
    if (fetchErr || !user) throw fetchErr || new Error('User fetch failed');

    const { regionName, regionCode } = await getRegion(user.region_id);

    const token = generateToken(user.id);
    res.json({ token, user: publicUser(user, regionName, regionCode) });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Signup failed' });
  }
});

router.put('/change-password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const { data: user, error } = await supabase.from('users').select('*').eq('id', req.user.id).single();
    if (error || !user) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    // 400 (not 401): a wrong current password is a form error, not an
    // expired session — a 401 here used to trigger the global logout
    // interceptor (audit C1).
    if (!valid) return res.status(400).json({ error: 'Current password is incorrect' });

    const newHash = await bcrypt.hash(newPassword, 10);
    const { error: updateErr } = await supabase
      .from('users')
      .update({ password_hash: newHash, must_change_password: false, updated_at: new Date().toISOString() })
      .eq('id', req.user.id);
    if (updateErr) throw updateErr;

    await auditLog(req.user.id, 'CHANGE_PASSWORD', 'users', req.user.id, null, null);
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

module.exports = router;

