const express = require('express');
const { randomUUID: uuidv4 } = require('crypto');
const { supabase } = require('../db');
const { authenticate, requireSuperAdmin } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');

const router = express.Router();

// ── Monthly Dues ────────────────────────────────────────────────────────────

router.put('/dues/:userId', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { due_month, due_year, amount, status, notes } = req.body;
    if (!due_month || !due_year || !status) return res.status(400).json({ error: 'Month, year and status are required' });
    if (!['paid','pending','arrears'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('id, is_active')
      .eq('id', req.params.userId)
      .single();
    if (userErr || !user || !user.is_active) return res.status(404).json({ error: 'User not found' });

    const { data: existing, error: existErr } = await supabase
      .from('monthly_dues')
      .select('id, status')
      .eq('user_id', req.params.userId)
      .eq('due_month', parseInt(due_month))
      .eq('due_year', parseInt(due_year))
      .limit(1);
    if (existErr) throw existErr;

    if (existing?.length) {
      const existId = existing[0].id;
      const oldStatus = existing[0].status;
      const { error: updateErr } = await supabase
        .from('monthly_dues')
        .update({
          amount: parseFloat(amount) || 0,
          status,
          notes: notes || null,
          updated_by: req.user.id,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existId);
      if (updateErr) throw updateErr;
      await auditLog(req.user.id, 'UPDATE_DUE', 'monthly_dues', existId, { status: oldStatus }, { status, amount });
    } else {
      const id = uuidv4();
      const now = new Date().toISOString();
      const { error: insertErr } = await supabase.from('monthly_dues').insert({
        id,
        user_id: req.params.userId,
        due_month: parseInt(due_month),
        due_year: parseInt(due_year),
        amount: parseFloat(amount) || 0,
        status,
        notes: notes || null,
        updated_by: req.user.id,
        created_at: now,
        updated_at: now,
      });
      if (insertErr) throw insertErr;
      await auditLog(req.user.id, 'CREATE_DUE', 'monthly_dues', id, null, { due_month, due_year, status, amount });
    }
    res.json({ message: 'Due record saved' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update due' });
  }
});

router.delete('/dues/:dueId', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('monthly_dues').delete().eq('id', req.params.dueId);
    if (error) throw error;
    await auditLog(req.user.id, 'DELETE_DUE', 'monthly_dues', req.params.dueId, null, null);
    res.json({ message: 'Due deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete due' });
  }
});

// ── Program Pledges ─────────────────────────────────────────────────────────

router.post('/pledges/program/:userId', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { program_name, pledge_amount, status, pledge_date, notes } = req.body;
    if (!program_name) return res.status(400).json({ error: 'Program name required' });

    const id = uuidv4();
    const now = new Date().toISOString();
    const { error } = await supabase.from('program_pledges').insert({
      id,
      user_id: req.params.userId,
      program_name,
      pledge_amount: parseFloat(pledge_amount) || 0,
      status: ['paid','pending','arrears'].includes(status) ? status : 'pending',
      pledge_date: pledge_date || null,
      notes: notes || null,
      updated_by: req.user.id,
      created_at: now,
      updated_at: now,
    });
    if (error) throw error;

    await auditLog(req.user.id, 'CREATE_PROGRAM_PLEDGE', 'program_pledges', id, null, { program_name, pledge_amount, status });
    res.status(201).json({ message: 'Pledge created', id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create pledge' });
  }
});

router.put('/pledges/program/:pledgeId', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { program_name, pledge_amount, status, pledge_date, notes } = req.body;
    const { error } = await supabase
      .from('program_pledges')
      .update({
        program_name,
        pledge_amount: parseFloat(pledge_amount) || 0,
        status,
        pledge_date: pledge_date || null,
        notes: notes || null,
        updated_by: req.user.id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.params.pledgeId);
    if (error) throw error;

    await auditLog(req.user.id, 'UPDATE_PROGRAM_PLEDGE', 'program_pledges', req.params.pledgeId, null, { status, pledge_amount });
    res.json({ message: 'Pledge updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update pledge' });
  }
});

router.delete('/pledges/program/:pledgeId', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('program_pledges').delete().eq('id', req.params.pledgeId);
    if (error) throw error;
    await auditLog(req.user.id, 'DELETE_PROGRAM_PLEDGE', 'program_pledges', req.params.pledgeId, null, null);
    res.json({ message: 'Pledge deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete pledge' });
  }
});

// ── Other Pledges ───────────────────────────────────────────────────────────

router.post('/pledges/other/:userId', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { description, pledge_amount, status, pledge_date, notes } = req.body;
    if (!description) return res.status(400).json({ error: 'Description required' });

    const id = uuidv4();
    const now = new Date().toISOString();
    const { error } = await supabase.from('other_pledges').insert({
      id,
      user_id: req.params.userId,
      description,
      pledge_amount: parseFloat(pledge_amount) || 0,
      status: ['paid','pending','arrears'].includes(status) ? status : 'pending',
      pledge_date: pledge_date || null,
      notes: notes || null,
      updated_by: req.user.id,
      created_at: now,
      updated_at: now,
    });
    if (error) throw error;

    await auditLog(req.user.id, 'CREATE_OTHER_PLEDGE', 'other_pledges', id, null, { description, pledge_amount, status });
    res.status(201).json({ message: 'Pledge created', id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create pledge' });
  }
});

router.put('/pledges/other/:pledgeId', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { description, pledge_amount, status, pledge_date, notes } = req.body;
    const { error } = await supabase
      .from('other_pledges')
      .update({
        description,
        pledge_amount: parseFloat(pledge_amount) || 0,
        status,
        pledge_date: pledge_date || null,
        notes: notes || null,
        updated_by: req.user.id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.params.pledgeId);
    if (error) throw error;

    await auditLog(req.user.id, 'UPDATE_OTHER_PLEDGE', 'other_pledges', req.params.pledgeId, null, { status, pledge_amount });
    res.json({ message: 'Pledge updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update pledge' });
  }
});

router.delete('/pledges/other/:pledgeId', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('other_pledges').delete().eq('id', req.params.pledgeId);
    if (error) throw error;
    await auditLog(req.user.id, 'DELETE_OTHER_PLEDGE', 'other_pledges', req.params.pledgeId, null, null);
    res.json({ message: 'Pledge deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete pledge' });
  }
});

module.exports = router;

