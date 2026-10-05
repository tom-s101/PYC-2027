const { createClient } = require('@supabase/supabase-js');

// Unified registrant lookup for the master dashboard.
// Given a name / email / PYC, returns a list of matching people with their
// complete picture: registration + conference group + dorm reservations +
// tent reservations + roommate requests.
//
// Two modes:
//   POST { query: "john" }  → returns array of matches (slim summary)
//   POST { registrationId: "uuid" } → returns full details for one person

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    let parsed;
    try { parsed = JSON.parse(event.body); } catch (e) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const registrationId = (parsed.registrationId || '').trim();
    const query = (parsed.query || '').trim();

    // Mode 1: Full details for one registrant
    if (registrationId) {
      return await getFullDetails(supabase, headers, registrationId);
    }

    // Mode 2: Search by name/email/PYC — returns match list
    if (!query || query.length < 2) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Search query required (min 2 characters)' }) };
    }

    return await searchRegistrants(supabase, headers, query);
  } catch (err) {
    console.error('md-registrant-full error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};

async function searchRegistrants(supabase, headers, query) {
  const q = query.trim();
  const isEmail = q.includes('@');
  const isPyc = /^pyc/i.test(q);
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q);

  let results = [];

  if (isUuid) {
    const { data } = await supabase
      .from('registrations')
      .select('id, first_name, last_name, email, gender, age, confirmation_number, payment_status, group_id, is_primary, registration_type, checked_in, region, location_type')
      .eq('id', q)
      .limit(10);
    results = data || [];
  } else if (isPyc) {
    const { data } = await supabase
      .from('registrations')
      .select('id, first_name, last_name, email, gender, age, confirmation_number, payment_status, group_id, is_primary, registration_type, checked_in, region, location_type')
      .ilike('confirmation_number', '%' + q + '%')
      .order('created_at', { ascending: false })
      .limit(30);
    results = data || [];
  } else if (isEmail) {
    const { data } = await supabase
      .from('registrations')
      .select('id, first_name, last_name, email, gender, age, confirmation_number, payment_status, group_id, is_primary, registration_type, checked_in, region, location_type')
      .ilike('email', '%' + q + '%')
      .order('created_at', { ascending: false })
      .limit(30);
    results = data || [];
  } else {
    // Name search — try both first and last name
    const parts = q.split(/\s+/).filter(function(p) { return p.length > 0; });
    if (parts.length >= 2) {
      const first = parts[0];
      const last = parts.slice(1).join(' ');
      const { data } = await supabase
        .from('registrations')
        .select('id, first_name, last_name, email, gender, age, confirmation_number, payment_status, group_id, is_primary, registration_type, checked_in, region, location_type')
        .or('and(first_name.ilike.%' + first + '%,last_name.ilike.%' + last + '%),and(first_name.ilike.%' + last + '%,last_name.ilike.%' + first + '%)')
        .order('created_at', { ascending: false })
        .limit(30);
      results = data || [];
      if (results.length === 0) {
        // Try broader OR match
        const { data: d2 } = await supabase
          .from('registrations')
          .select('id, first_name, last_name, email, gender, age, confirmation_number, payment_status, group_id, is_primary, registration_type, checked_in, region, location_type')
          .or('first_name.ilike.%' + first + '%,last_name.ilike.%' + last + '%,first_name.ilike.%' + last + '%,last_name.ilike.%' + first + '%')
          .order('created_at', { ascending: false })
          .limit(30);
        results = d2 || [];
      }
    } else {
      const { data } = await supabase
        .from('registrations')
        .select('id, first_name, last_name, email, gender, age, confirmation_number, payment_status, group_id, is_primary, registration_type, checked_in, region, location_type')
        .or('first_name.ilike.%' + q + '%,last_name.ilike.%' + q + '%')
        .order('created_at', { ascending: false })
        .limit(30);
      results = data || [];
    }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ success: true, count: results.length, matches: results })
  };
}

async function getFullDetails(supabase, headers, registrationId) {
  // Load the registrant
  const { data: reg, error: regErr } = await supabase
    .from('registrations')
    .select('*')
    .eq('id', registrationId)
    .single();

  if (regErr || !reg) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Registrant not found' }) };
  }

  // Load conference registration group members if part of a group
  let registrationGroup = null;
  if (reg.group_id) {
    const { data: group } = await supabase
      .from('registrations')
      .select('id, first_name, last_name, email, gender, age, confirmation_number, payment_status, is_primary, checked_in, tshirt_size, meal_plan')
      .eq('group_id', reg.group_id)
      .order('is_primary', { ascending: false });
    if (group && group.length > 0) registrationGroup = group;
  }

  // Load dorm reservations — match by registration_id OR email
  const email = (reg.email || '').toLowerCase();
  let dormReservations = [];
  try {
    const { data: byId } = await supabase
      .from('accommodation_reservations')
      .select('*')
      .eq('registration_id', registrationId);
    if (byId) dormReservations = byId;
    if (email) {
      const { data: byEmail } = await supabase
        .from('accommodation_reservations')
        .select('*')
        .ilike('registrant_email', email);
      if (byEmail) {
        const existingIds = new Set(dormReservations.map(function(r) { return r.id; }));
        byEmail.forEach(function(r) {
          if (!existingIds.has(r.id)) dormReservations.push(r);
        });
      }
    }
  } catch (e) { console.error('Dorm res error:', e.message); }

  // Load tent reservations — as booker (registration_id) or as a member (by PYC in members[])
  let tentReservations = [];
  try {
    const { data: tentsByRegId } = await supabase
      .from('tent_reservations')
      .select('*')
      .eq('registration_id', registrationId);
    if (tentsByRegId) tentReservations = tentsByRegId;
    if (email) {
      const { data: tentsByEmail } = await supabase
        .from('tent_reservations')
        .select('*')
        .ilike('registrant_email', email);
      if (tentsByEmail) {
        const existingIds = new Set(tentReservations.map(function(r) { return r.id; }));
        tentsByEmail.forEach(function(r) {
          if (!existingIds.has(r.id)) tentReservations.push(r);
        });
      }
    }
    // Also find tents where this person is a MEMBER (not the booker)
    if (reg.confirmation_number) {
      const targetPyc = reg.confirmation_number.toUpperCase();
      const { data: allTents } = await supabase
        .from('tent_reservations')
        .select('*')
        .eq('status', 'Active');
      if (allTents) {
        const existingIds = new Set(tentReservations.map(function(r) { return r.id; }));
        allTents.forEach(function(t) {
          if (existingIds.has(t.id)) return;
          const members = Array.isArray(t.members) ? t.members : [];
          if (members.some(function(m) { return m.pycNumber && m.pycNumber.toUpperCase() === targetPyc; })) {
            tentReservations.push(t);
          }
        });
      }
    }
  } catch (e) { console.error('Tent res error:', e.message); }

  // Roommate requests — as requester or member
  let roommateAsRequester = null;
  let roommateAsMember = null;
  try {
    const { data: allReqs } = await supabase
      .from('roommate_requests')
      .select('*')
      .eq('status', 'Active');
    if (allReqs) {
      for (const rr of allReqs) {
        if (rr.requester_registration_id === registrationId) {
          roommateAsRequester = rr;
          continue;
        }
        if (reg.confirmation_number && rr.requester_pyc &&
            rr.requester_pyc.toUpperCase() === reg.confirmation_number.toUpperCase()) {
          roommateAsRequester = rr;
          continue;
        }
        const members = Array.isArray(rr.requested_members) ? rr.requested_members : [];
        if (reg.confirmation_number) {
          const pyc = reg.confirmation_number.toUpperCase();
          if (members.some(function(m) { return m.pycNumber && m.pycNumber.toUpperCase() === pyc; })) {
            roommateAsMember = rr;
          }
        }
      }
    }
  } catch (e) { console.error('Roommate error:', e.message); }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      registrant: reg,
      registrationGroup: registrationGroup,
      dormReservations: dormReservations,
      tentReservations: tentReservations,
      roommateAsRequester: roommateAsRequester,
      roommateAsMember: roommateAsMember
    })
  };
}
