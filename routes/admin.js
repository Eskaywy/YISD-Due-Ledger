const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const uuidv4 = crypto.randomUUID;
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const { supabase, generateUserId } = require('../db');
const { authenticate, requireSuperAdmin } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');

const router = express.Router();
const upload = multer({ dest: 'uploads/', limits: { fileSize: 5 * 1024 * 1024 } });

const mapMember = (m = {}) => ({
  id: m.id,
  user_id_code: m.user_id_code ?? null,
  full_name: m.full_name ?? null,
  email: m.email ?? null,
  position: m.position ?? null,
  dept_code: m.dept_code ?? null,
  region_id: m.region_id ?? null,
  role: m.role ?? 'member',
  is_active: m.is_active ?? true,
  created_at: m.created_at ?? null,
  updated_at: m.updated_at ?? null,
});

// Dashboard stats
router.get('/stats', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const [membersRes, duesRes, logsRes, regionsRes] = await Promise.all([
      supabase.from('users').select('id, region_id').eq('role', 'member').eq('is_active', true),
      supabase.from('monthly_dues').select('user_id, amount, status'),
      supabase.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(10),
      supabase.from('regions').select('*').order('name'),
    ]);
    if (membersRes.error || duesRes.error || logsRes.error || regionsRes.error) {
      throw membersRes.error || duesRes.error || logsRes.error || regionsRes.error;
    }

    const members = membersRes.data || [];
    const totalMembers = members.length;

    let paidMembersSet = new Set(), arrearsMembersSet = new Set(), totalCollected = 0;
    for (const due of duesRes.data || []) {
      if (due.status === 'paid') {
        totalCollected += Number(due.amount);
        paidMembersSet.add(due.user_id);
      } else if (due.status === 'arrears') {
        arrearsMembersSet.add(due.user_id);
      }
    }

    // Resolve actor names for the recent activity feed in a single batched query.
    const logs = logsRes.data || [];
    const actorIds = [...new Set(logs.map(l => l.actor_id).filter(Boolean))];
    const actorNames = new Map();
    if (actorIds.length) {
      const { data: actors, error: actorsErr } = await supabase
        .from('users')
        .select('id, full_name')
        .in('id', actorIds);
      if (actorsErr) throw actorsErr;
      for (const a of actors || []) actorNames.set(a.id, a.full_name);
    }
    const recentActivity = logs.map(log => ({
      id: log.id,
      action: log.action,
      target_table: log.target_table ?? null,
      target_id: log.target_id ?? null,
      actor_name: actorNames.get(log.actor_id) || 'Unknown',
      created_at: log.created_at ?? null,
    }));

    // Region stats: collect paid amounts per region via one pass over the dues.
    const regionById = new Map((regionsRes.data || []).map(r => [r.id, r]));
    const memberRegion = new Map(members.map(m => [m.id, m.region_id]));
    const regionStats = (regionsRes.data || []).map(r => ({ name: r.name, code: r.code, member_count: 0, collected: 0 }));
    const statByName = new Map(regionStats.map(s => [s.name, s]));
    for (const m of members) {
      const region = regionById.get(m.region_id);
      const stat = statByName.get(region?.name);
      if (stat) stat.member_count++;
    }
    for (const due of duesRes.data || []) {
      if (due.status !== 'paid') continue;
      const region = regionById.get(memberRegion.get(due.user_id));
      const stat = statByName.get(region?.name);
      if (stat) stat.collected += Number(due.amount);
    }

    res.json({
      total_members: totalMembers,
      paid_members: paidMembersSet.size,
      arrears_members: arrearsMembersSet.size,
      total_collected: totalCollected,
      recent_activity: recentActivity,
      region_stats: regionStats
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// List members
router.get('/members', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { search, region_id, page = 1, limit = 15, archived } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabase
      .from('users')
      .select('*, regions(name)')
      .eq('role', 'member')
      // archived=1 shows archived members so they can be restored (audit H5);
      // default remains active-only.
      .eq('is_active', archived === '1' ? false : true);
    if (region_id) {
      query = query.eq('region_id', region_id);
    }

    const { data: rows, error } = await query;
    if (error) throw error;

    let members = (rows || []).map(row => ({
      ...mapMember(row),
      region_name: row.regions?.name ?? null,
      region_id: row.region_id,
    }));

    if (search) {
      const searchLower = search.toLowerCase();
      members = members.filter(m =>
        (m.full_name || '').toLowerCase().includes(searchLower) ||
        (m.user_id_code || '').toLowerCase().includes(searchLower) ||
        (m.email || '').toLowerCase().includes(searchLower));
    }

    members.sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
    const total = members.length;
    const paginatedMembers = members.slice(offset, offset + parseInt(limit));
    res.json({ members: paginatedMembers, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch members' });
  }
});

// Single member with full ledger
router.get('/members/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { data: member, error: memberErr } = await supabase
      .from('users')
      .select('*, regions(name, code)')
      .eq('id', req.params.id)
      .single();
    if (memberErr || !member || member.role !== 'member' || !member.is_active) {
      return res.status(404).json({ error: 'Member not found' });
    }

    // Region name and the three ledger queries are independent, so run them
    // concurrently instead of sequential round trips.
    const [duesRes, programRes, otherRes] = await Promise.all([
      supabase.from('monthly_dues').select('*')
        .eq('user_id', req.params.id)
        .order('due_year', { ascending: false })
        .order('due_month', { ascending: false }),
      supabase.from('program_pledges').select('*')
        .eq('user_id', req.params.id)
        .order('created_at', { ascending: false }),
      supabase.from('other_pledges').select('*')
        .eq('user_id', req.params.id)
        .order('created_at', { ascending: false }),
    ]);
    if (duesRes.error || programRes.error || otherRes.error) {
      throw duesRes.error || programRes.error || otherRes.error;
    }

    res.json({
      member: {
        ...mapMember(member),
        region_name: member.regions?.name ?? null,
        region_code: member.regions?.code ?? null,
      },
      dues: duesRes.data || [],
      program_pledges: programRes.data || [],
      other_pledges: otherRes.data || [],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch member' });
  }
});

// Create member
router.post('/members', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { full_name, email, position, region_id, dept_code } = req.body;
    if (!full_name || !email || !region_id) return res.status(400).json({ error: 'Name, email, and region are required' });

    const { data: dup, error: dupErr } = await supabase
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase())
      .limit(1);
    if (dupErr) throw dupErr;
    if (dup?.length) return res.status(409).json({ error: 'Email already exists' });

    const { data: region, error: regionErr } = await supabase
      .from('regions')
      .select('*')
      .eq('id', region_id)
      .single();
    if (regionErr || !region) return res.status(400).json({ error: 'Invalid region' });

    const dCode = (dept_code || 'MED').toUpperCase();
    const userId = uuidv4();
    const userIdCode = await generateUserId(region.code, dCode);
    // Cryptographically random temp password instead of a fixed shared one.
    // Keeps the Member@… shape the password policy expects (upper, lower, digit, symbol).
    const tempPass = `Member@${crypto.randomBytes(4).toString('hex')}`;
    const hash = await bcrypt.hash(tempPass, 10);

    const now = new Date().toISOString();
    const { error: insertErr } = await supabase.from('users').insert({
      id: userId,
      user_id_code: userIdCode,
      full_name: full_name.trim(),
      email: email.toLowerCase().trim(),
      password_hash: hash,
      position: position || '',
      region_id,
      dept_code: dCode,
      role: 'member',
      is_active: true,
      must_change_password: true,
      created_at: now,
      updated_at: now,
    });
    if (insertErr) throw insertErr;

    await auditLog(req.user.id, 'CREATE_MEMBER', 'users', userId, null, { full_name, email, userIdCode });
    res.status(201).json({ message: 'Member created', id: userId, user_id_code: userIdCode, temp_password: tempPass });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create member' });
  }
});


// Update member
router.put('/members/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { data: before, error: beforeErr } = await supabase
      .from('users')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (beforeErr || !before) return res.status(404).json({ error: 'Member not found' });
    delete before.password_hash;

    const { full_name, email, position, region_id, dept_code, is_active } = req.body;

    // Enforce the same email-uniqueness rule as member creation so an admin
    // edit cannot collide two accounts onto one login identity.
    if (email && email.toLowerCase() !== String(before.email).toLowerCase()) {
      const { data: dup, error: dupErr } = await supabase
        .from('users')
        .select('id')
        .eq('email', email.toLowerCase())
        .limit(1);
      if (dupErr) throw dupErr;
      if (dup?.length) return res.status(409).json({ error: 'Email already exists' });
    }

    const { error: updateErr } = await supabase
      .from('users')
      .update({
        full_name: full_name || before.full_name,
        email: email || before.email,
        position: position ?? before.position,
        region_id: region_id || before.region_id,
        dept_code: dept_code || before.dept_code,
        is_active: is_active !== undefined ? is_active : before.is_active,
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.params.id);
    if (updateErr) throw updateErr;

    await auditLog(req.user.id, 'UPDATE_MEMBER', 'users', req.params.id, before, req.body);
    res.json({ message: 'Member updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update member' });
  }
});

// Soft-delete member
router.delete('/members/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { data: member, error: memberErr } = await supabase
      .from('users')
      .select('full_name')
      .eq('id', req.params.id)
      .single();
    if (memberErr || !member) return res.status(404).json({ error: 'Member not found' });

    const { error: updateErr } = await supabase
      .from('users')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);
    if (updateErr) throw updateErr;

    await auditLog(req.user.id, 'DELETE_MEMBER', 'users', req.params.id, { fullName: member.full_name }, null);
    res.json({ message: 'Member archived' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to archive member' });
  }
});

// Restore an archived member (audit H5 — archive is no longer one-way).
router.post('/members/:id/restore', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { data: member, error: memberErr } = await supabase
      .from('users')
      .select('full_name, is_active')
      .eq('id', req.params.id)
      .single();
    if (memberErr || !member) return res.status(404).json({ error: 'Member not found' });
    if (member.is_active) return res.status(400).json({ error: 'Member is already active' });

    const { error: updateErr } = await supabase
      .from('users')
      .update({ is_active: true, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);
    if (updateErr) throw updateErr;

    await auditLog(req.user.id, 'UPDATE_MEMBER', 'users', req.params.id, { is_active: false }, { is_active: true, fullName: member.full_name });
    res.json({ message: 'Member restored' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to restore member' });
  }
});


// Get regions
router.get('/regions', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('regions').select('*').order('name');
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch regions' });
  }
});

// Batch upload CSV / Excel
router.post('/batch-upload', authenticate, requireSuperAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const ext = path.extname(req.file.originalname).toLowerCase();
    let records = [];

    if (ext === '.csv') {
      const content = fs.readFileSync(req.file.path, 'utf8');
      records = parse(content, { columns: true, skip_empty_lines: true, trim: true });
    } else if (['.xlsx', '.xls'].includes(ext)) {
      const wb = XLSX.readFile(req.file.path);
      records = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    } else {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Only CSV or Excel files accepted' });
    }
    fs.unlinkSync(req.file.path);

    const errors = [], successes = [];

    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      const rowNum = i + 2;

      let userId = null;
      if (row.user_id) {
        const { data } = await supabase.from('users').select('id').eq('user_id_code', row.user_id).limit(1);
        if (data?.length) userId = data[0].id;
      }
      if (!userId && row.email) {
        const { data } = await supabase.from('users').select('id').eq('email', row.email).limit(1);
        if (data?.length) userId = data[0].id;
      }
      if (!userId) {
        errors.push({ row: rowNum, error: `User not found: ${row.user_id || row.email}` });
        continue;
      }

      if (row.due_month && row.due_year) {
        const month = parseInt(row.due_month), year = parseInt(row.due_year);
        const status = ['paid','pending','arrears'].includes(row.due_status) ? row.due_status : 'pending';
        if (month < 1 || month > 12 || year < 2000) {
          errors.push({ row: rowNum, error: `Invalid month/year: ${month}/${year}` });
        } else {
          const { data: existingDue } = await supabase
            .from('monthly_dues')
            .select('id')
            .eq('user_id', userId)
            .eq('due_month', month)
            .eq('due_year', year)
            .limit(1);
          const now = new Date().toISOString();
          if (existingDue?.length) {
            const { error: upErr } = await supabase
              .from('monthly_dues')
              .update({
                amount: parseFloat(row.due_amount) || 0,
                status,
                updated_by: req.user.id,
                updated_at: now,
              })
              .eq('id', existingDue[0].id);
            if (upErr) throw upErr;
          } else {
            const { error: insErr } = await supabase.from('monthly_dues').insert({
              id: uuidv4(),
              user_id: userId,
              due_month: month,
              due_year: year,
              amount: parseFloat(row.due_amount) || 0,
              status,
              updated_by: req.user.id,
              created_at: now,
              updated_at: now,
            });
            if (insErr) throw insErr;
          }
          successes.push(rowNum);
        }
      }

      if (row.pledge_program) {
        const now = new Date().toISOString();
        const { error: pledgeErr } = await supabase.from('program_pledges').insert({
          id: uuidv4(),
          user_id: userId,
          program_name: row.pledge_program,
          pledge_amount: parseFloat(row.pledge_amount) || 0,
          status: ['paid','pending','arrears'].includes(row.pledge_status) ? row.pledge_status : 'pending',
          pledge_date: row.pledge_date || null,
          updated_by: req.user.id,
          created_at: now,
          updated_at: now,
        });
        if (pledgeErr) throw pledgeErr;
        successes.push(`${rowNum}(pledge)`);
      }
    }

    await auditLog(req.user.id, 'BATCH_UPLOAD', 'multiple', null, null, { successes: successes.length, errors: errors.length });
    res.json({ processed: records.length, successes: successes.length, errors });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Batch upload failed: ' + err.message });
  }
});


// Export members to Excel
router.get('/export', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { region_id, search } = req.query;
    let query = supabase
      .from('users')
      .select('*, regions(name)')
      .eq('role', 'member')
      .eq('is_active', true);
    if (region_id) {
      query = query.eq('region_id', region_id);
    }

    const { data: rows, error } = await query;
    if (error) throw error;

    let members = (rows || []).map(row => ({
      user_id_code: row.user_id_code,
      full_name: row.full_name,
      email: row.email,
      position: row.position,
      region: row.regions?.name ?? '',
      created_at: row.created_at,
    }));
    // Honour the on-screen search filter so exports match what the admin sees
    // (audit F6).
    if (search) {
      const s = search.toLowerCase();
      members = members.filter(m =>
        (m.full_name || '').toLowerCase().includes(s) ||
        (m.user_id_code || '').toLowerCase().includes(s) ||
        (m.email || '').toLowerCase().includes(s));
    }
    members.sort((a, b) => a.region.localeCompare(b.region) || a.full_name.localeCompare(b.full_name));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(members), 'Members');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="members-export.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Export failed' });
  }
});

// Audit logs
router.get('/audit-logs', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { data: logs, error } = await supabase
      .from('audit_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;

    const actorIds = [...new Set((logs || []).map(l => l.actor_id).filter(Boolean))];
    const actorNames = new Map();
    if (actorIds.length) {
      const { data: actors, error: actorsErr } = await supabase
        .from('users')
        .select('id, full_name')
        .in('id', actorIds);
      if (actorsErr) throw actorsErr;
      for (const a of actors || []) actorNames.set(a.id, a.full_name);
    }

    res.json((logs || []).map(log => ({
      id: log.id,
      action: log.action,
      target_table: log.target_table ?? null,
      target_id: log.target_id ?? null,
      actor_name: actorNames.get(log.actor_id) || 'Unknown',
      before_value: log.before_value ?? null,
      after_value: log.after_value ?? null,
      created_at: log.created_at ?? null,
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

module.exports = router;

