const { supabase } = require('../supabaseAdmin');
const { randomUUID: uuidv4 } = require('crypto');

const auditLog = async (actorId, action, targetTable, targetId, beforeValue, afterValue) => {
  try {
    const auditId = uuidv4();
    const { error } = await supabase.from('audit_logs').insert({
      id: auditId,
      actor_id: actorId,
      action,
      target_table: targetTable,
      target_id: targetId,
      before_value: beforeValue ? JSON.stringify(beforeValue) : null,
      after_value: afterValue ? JSON.stringify(afterValue) : null,
      created_at: new Date().toISOString(),
    });
    if (error) throw error;
  } catch (err) {
    console.error('Audit log error:', err);
  }
};

module.exports = { auditLog };
