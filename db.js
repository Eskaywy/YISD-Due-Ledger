const { supabase } = require("./supabaseAdmin");
const bcrypt = require('bcryptjs');
const { randomUUID: uuidv4 } = require('crypto');

const initDatabase = async () => {
  console.log('Checking Supabase for existing data...');
  const { count, error } = await supabase
    .from('regions')
    .select('id', { count: 'exact', head: true });
  if (error) throw error;

  // Always ensure the five canonical regions exist (idempotent upsert by
  // code). This runs regardless of prior data so existing deployments get
  // the LAG/SWE/NOR/SEA/SST prefix registry from the approved plan.
  await ensureCanonicalRegions();

  if (!count) {
    const seedDemo = process.env.NODE_ENV !== 'production' && process.env.SEED_DEMO_DATA === 'true';
    if (seedDemo) {
      console.log('Seeding demo data (SEED_DEMO_DATA enabled, non-production)...');
      await seedData();
    } else {
      console.log('Empty database initialised with canonical regions only (no demo seed).');
    }
  } else {
    console.log('Supabase already has data.');
  }
};

// Canonical region prefix registry (approved plan §3.1). Codes are 3 uppercase
// letters and feed the Smart Ledger ID prefix: LAG-MED-1001.
const CANONICAL_REGIONS = [
  { name: 'Lagos',       code: 'LAG' },
  { name: 'South-West',  code: 'SWE' },
  { name: 'North',       code: 'NOR' },
  { name: 'South-East',  code: 'SEA' },
  { name: 'South-South', code: 'SST' },
];

const ensureCanonicalRegions = async () => {
  const now = new Date().toISOString();
  for (const r of CANONICAL_REGIONS) {
    const { data: existing, error: selErr } = await supabase
      .from('regions')
      .select('id, code')
      .eq('code', r.code)
      .limit(1);
    if (selErr) throw selErr;
    if (existing?.length) {
      // Normalise the display name if it drifted (e.g. casing/hyphenation).
      if (existing[0].name !== r.name) {
        const { error: updErr } = await supabase
          .from('regions')
          .update({ name: r.name })
          .eq('id', existing[0].id);
        if (updErr) throw updErr;
      }
      continue;
    }
    const { error: insErr } = await supabase
      .from('regions')
      .insert({ id: uuidv4(), name: r.name, code: r.code, created_at: now });
    if (insErr && insErr.code !== '23505') throw insErr; // tolerate concurrent race
  }
};

const seedData = async () => {
  const lgsId = uuidv4();
  const swrId = uuidv4();
  const now = new Date().toISOString();
  const { error: regionErr } = await supabase.from('regions').insert([
    { id: lgsId, name: 'Lagos', code: 'LAG', created_at: now },
    { id: swrId, name: 'South-West', code: 'SWE', created_at: now },
  ]);
  if (regionErr && regionErr.code !== '23505') throw regionErr;

  // Departments used by the seeded members (Information + Media).
  const { error: deptErr } = await supabase.from('departments').insert([
    { id: uuidv4(), name: 'Media', code: 'MED', created_at: now },
    { id: uuidv4(), name: 'Information', code: 'INF', created_at: now },
  ]);
  if (deptErr && deptErr.code !== '23505') throw deptErr;

  // Resolve the region ids we just ensured exist (they may already have been
  // present via ensureCanonicalRegions).
  const resolveRegion = async (code) => {
    const { data, error } = await supabase.from('regions').select('id').eq('code', code).limit(1);
    if (error) throw error;
    return data?.[0]?.id;
  };
  const lagId = await resolveRegion('LAG') || lgsId;
  const sweId = await resolveRegion('SWE') || swrId;

  const superAdminId = uuidv4();
  // Demo credentials come from env only — never hardcoded in source.
  // The seed runs only when SEED_DEMO_DATA=true and NODE_ENV != production.
  const superAdminEmail = process.env.SEED_SUPERADMIN_EMAIL || '';
  const superAdminPassword = process.env.SEED_SUPERADMIN_PASSWORD || '';
  const memberPassword = process.env.SEED_MEMBER_PASSWORD || '';
  const superAdminPasswordHash = superAdminPassword ? await bcrypt.hash(superAdminPassword, 10) : null;
  const memberPasswordHash = memberPassword ? await bcrypt.hash(memberPassword, 10) : null;
  const memberSeeds = [
    { name: 'Adewale Ogundimu', email: process.env.SEED_MEMBER1_EMAIL || '', position: 'Journalist', regionId: lagId, rc: 'LAG', seq: '0002' },
    { name: 'Chidinma Okafor', email: process.env.SEED_MEMBER2_EMAIL || '', position: 'Editor', regionId: lagId, rc: 'LAG', seq: '0003' },
    { name: 'Babatunde Fashola', email: process.env.SEED_MEMBER3_EMAIL || '', position: 'Correspondent', regionId: lagId, rc: 'LAG', seq: '0004' },
    { name: 'Ngozi Adeyemi', email: process.env.SEED_MEMBER4_EMAIL || '', position: 'Producer', regionId: sweId, rc: 'SWE', seq: '0001' },
    { name: 'Seun Abegunrin', email: process.env.SEED_MEMBER5_EMAIL || '', position: 'Presenter', regionId: sweId, rc: 'SWE', seq: '0002' },
  ].filter(m => m.email && memberPasswordHash);
  const memberIds = memberSeeds.map(() => uuidv4());

  const userRows = [
    {
      id: superAdminId,
      user_id_code: 'LAG-MED-202506-0001',
      full_name: 'Super Administrator',
      email: superAdminEmail,
      password_hash: superAdminPasswordHash,
      position: 'Super Administrator',
      region_id: lagId,
      dept_code: 'MED',
      role: 'super_admin',
      is_active: true,
      created_at: now,
      updated_at: now,
    },
    ...memberSeeds.map((m, i) => ({
      id: memberIds[i],
      user_id_code: `${m.rc}-MED-202506-${m.seq}`,
      full_name: m.name,
      email: m.email,
      password_hash: memberPasswordHash,
      position: m.position,
      region_id: m.regionId,
      dept_code: 'MED',
      role: 'member',
      is_active: true,
      created_at: now,
      updated_at: now,
    })),
  ];
  const { error: userErr } = await supabase.from('users').insert(userRows);
  if (userErr && userErr.code !== '23505') throw userErr;

  const dueStatuses = ['paid','paid','paid','paid','arrears','pending'];
  const dueMonths   = [1, 2, 3, 4, 5, 6];
  const dueRows = [];
  for (const mid of memberIds.slice(0, 3)) {
    for (let i = 0; i < dueMonths.length; i++) {
      dueRows.push({
        id: uuidv4(),
        user_id: mid,
        due_month: dueMonths[i],
        due_year: 2025,
        amount: 2000,
        status: dueStatuses[i],
        updated_by: superAdminId,
        created_at: now,
        updated_at: now,
      });
    }
  }
  const { error: dueErr } = await supabase.from('monthly_dues').insert(dueRows);
  if (dueErr) throw dueErr;

  const programRows = [];
  for (const mid of memberIds) {
    programRows.push(
      {
        id: uuidv4(), user_id: mid, program_name: 'Annual Media Conference',
        pledge_amount: 50000, status: 'pending', pledge_date: '2025-06-15',
        updated_by: superAdminId, created_at: now, updated_at: now,
      },
      {
        id: uuidv4(), user_id: mid, program_name: 'Community Outreach',
        pledge_amount: 25000, status: 'paid', pledge_date: '2025-05-10',
        updated_by: superAdminId, created_at: now, updated_at: now,
      }
    );
  }
  const otherRows = memberIds.slice(0, 3).map((mid) => ({
    id: uuidv4(), user_id: mid, description: 'Building fund',
    pledge_amount: 10000, status: 'pending', pledge_date: '2025-04-01',
    updated_by: superAdminId, created_at: now, updated_at: now,
  }));

  const { error: pledgeErr } = await supabase.from('program_pledges').insert(programRows);
  if (pledgeErr) throw pledgeErr;
  const { error: otherErr } = await supabase.from('other_pledges').insert(otherRows);
  if (otherErr) throw otherErr;

  // FIX: last_seq must reflect how many codes were actually used in each
  // region's own (region, dept, month) bucket. LGS used 0001-0004 (4
  // users: super admin + 3 members), not 6 -- the old value of 6 would
  // cause the next real LGS signup to skip straight to 0007. SWR's value
  // of 2 was already correct once SWR's own codes restart at 0001.
  const { error: seqErr } = await supabase.from('user_id_sequences').insert([
    { region_code: 'LGS', dept_code: 'MED', year_month: '202506', last_seq: 4 },
    { region_code: 'SWR', dept_code: 'MED', year_month: '202506', last_seq: 2 },
  ]);
  if (seqErr) throw seqErr;

  console.log('Supabase seed data inserted!');
};

// ---- Smart Ledger ID minting (approved plan §3.2) ----
// Canonical format: [3-letter REGION]-[3-letter DEPT]-[serial], e.g. LAG-MED-1001.
// Region codes come from the canonical registry (LAG/SWE/NOR/SEA/SST) or are
// derived from custom names; department codes from the stored code (INF/MED)
// or are derived. Both are forced to 3 uppercase letters.

// First 3 letters of a name, uppercase (Media -> MED, Information -> INF)
const prefixFromName = (name) =>
  (((name || '').replace(/[^A-Za-z]/g, '').toUpperCase()) + 'XXX').slice(0, 3);

// Region prefix: the stored 3-letter code wins, else derive from the name.
const regionPrefixFor = (name, code) =>
  (code ? String(code).toUpperCase().slice(0, 3) : null) || prefixFromName(name);

// Enforce the 3-letter shape on any prefix before it reaches an ID.
const normalizePrefix = (p) => {
  const s = String(p || '').toUpperCase().replace(/[^A-Z]/g, '');
  return (s + 'XXX').slice(0, 3);
};

// Pick a 3-letter code not already used in the table, so custom "Other"
// regions/departments never collide on a unique code constraint.
const resolveUniqueCode = async (tableName, base) => {
  const root = normalizePrefix(base);
  const { data, error } = await supabase.from(tableName).select('code');
  if (error) throw error;
  const taken = new Set((data || []).map(r => String(r.code || '').toUpperCase()));
  if (!taken.has(root)) return root;
  const [a, b] = root;
  // Rotate the third character, then the second, to find a free variant.
  for (let i = 1; i <= 26; i++) {
    const c = String.fromCharCode(((root.charCodeAt(2) - 65 + i) % 26) + 65);
    const cand = a + b + c;
    if (!taken.has(cand)) return cand;
  }
  for (let i = 1; i <= 26; i++) {
    const b2 = String.fromCharCode(((b.charCodeAt(0) - 65 + i) % 26) + 65);
    for (let j = 0; j < 26; j++) {
      const cand = a + b2 + String.fromCharCode(65 + j);
      if (!taken.has(cand)) return cand;
    }
  }
  return root;
};

// Parse a composite member ID (new 3-3-serial or legacy 4-part format).
// New: LAG-MED-1001  → { regionCode, deptCode, serial, format: 'v2' }
// Legacy: LGS-MED-202506-0001 → { regionCode, deptCode, yearMonth, serial, format: 'v1' }
// Returns null when the input is not a recognisable member ID.
const parseMemberId = (raw) => {
  const v = String(raw || '').trim().toUpperCase();
  const v2 = /^([A-Z]{3})-([A-Z]{3})-(\d{4,})$/.exec(v);
  if (v2) return { regionCode: v2[1], deptCode: v2[2], serial: Number(v2[3]), format: 'v2' };
  const v1 = /^([A-Z0-9]{2,3})-([A-Z]{3})-(\d{6})-(\d{4})$/.exec(v);
  if (v1) return { regionCode: v1[1], deptCode: v1[2], yearMonth: v1[3], serial: Number(v1[4]), format: 'v1' };
  return null;
};

// Serial lives in counters/member_serial and is bumped atomically by the
// Postgres function next_member_serial() (supabase/schema.sql) so concurrent
// sign-ups can never mint the same serial.
const generateSmartId = async ({ regionName, regionCode, deptName, deptCode }) => {
  const rPrefix = normalizePrefix(regionPrefixFor(regionName, regionCode));
  const dPrefix = normalizePrefix(deptCode || prefixFromName(deptName));
  const { data, error } = await supabase.rpc('next_member_serial');
  if (error) throw error;
  const serial = data;
  return `${rPrefix}-${dPrefix}-${serial}`;
};

const generateUserId = async (regionCode, deptCode) => {
  const now = new Date();
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  // Atomic per (region, dept, month) sequence via the next_user_sequence RPC.
  const { data, error } = await supabase.rpc('next_user_sequence', {
    p_region_code: regionCode,
    p_dept_code: deptCode,
    p_year_month: ym,
  });
  if (error) throw error;
  return `${regionCode}-${deptCode}-${ym}-${String(data).padStart(4, '0')}`;
};

// Upsert-by-name helpers backing the prototype's "Other" dropdowns (signup.html):
// if the signup form names a department/region that doesn't exist yet, it is
// created and becomes a standard option for everyone afterwards.
const findOrCreateNamed = async (tableName, rawName, buildCode) => {
  const name = String(rawName || '').trim();
  if (!name) return null;
  const lower = name.toLowerCase();
  const { data: existing, error: selErr } = await supabase
    .from(tableName)
    .select('*')
    .ilike('name', name)
    .limit(1);
  if (selErr) throw selErr;
  if (existing && existing.length && String(existing[0].name || '').trim().toLowerCase() === lower) {
    const row = existing[0];
    return { id: row.id, name: row.name, code: row.code ?? null };
  }

  // Insert with a collision-free 3-letter code; retry a few times on a
  // concurrent unique violation (name or code) before surfacing the error.
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = await resolveUniqueCode(tableName, buildCode(name));
    const doc = { id: uuidv4(), name, code, created_at: new Date().toISOString() };
    const { error: insErr } = await supabase.from(tableName).insert(doc);
    if (!insErr) return doc;
    if (insErr.code !== '23505') throw insErr;
    lastErr = insErr;
    // Lost a race — if the name now exists, return the winner.
    const { data: winner } = await supabase.from(tableName).select('*').ilike('name', name).limit(1);
    if (winner && winner.length) {
      return { id: winner[0].id, name: winner[0].name, code: winner[0].code ?? null };
    }
    // Otherwise it was a code collision — loop and pick a different code.
  }
  throw lastErr || new Error('Failed to create ' + tableName + ' entry');
};

// Resolve a department by code first (existing dropdown pick), else by name
// (the "Other" path — new entries get a 3-letter code like INF/MED).
const findOrCreateDepartment = async (deptCode, deptName) => {
  const code = String(deptCode || '').trim().toUpperCase();
  if (code) {
    const { data, error } = await supabase
      .from('departments')
      .select('*')
      .eq('code', code)
      .limit(1);
    if (error) throw error;
    if (data && data.length) {
      const row = data[0];
      return { id: row.id, name: row.name, code: row.code ?? null };
    }
  }
  return findOrCreateNamed('departments', deptName, prefixFromName);
};

// Resolve a region by id first, else upsert by name ("Other" path — the code
// honours the prototype's prefix overrides, e.g. "Lagos 2" -> LA2).
const findOrCreateRegion = async (regionId, regionName) => {
  if (regionId) {
    const { data, error } = await supabase
      .from('regions')
      .select('*')
      .eq('id', String(regionId))
      .limit(1);
    if (error) throw error;
    if (data && data.length) {
      const row = data[0];
      return { id: row.id, name: row.name, code: row.code ?? null };
    }
  }
  return findOrCreateNamed('regions', regionName, (n) => regionPrefixFor(n, null));
};

module.exports = { initDatabase, supabase, generateUserId, generateSmartId, parseMemberId, prefixFromName, regionPrefixFor, findOrCreateDepartment, findOrCreateRegion };