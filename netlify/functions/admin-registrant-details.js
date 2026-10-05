const { createClient } = require('@supabase/supabase-js');

// Admin tool: fetch all related info for a single registrant.
// Used by the "All Reservations" and "Tenting" tabs in ar.html for the expandable
// search results — shows conference registration group members and roommate
// requests (as requester and as member).
//
// Input (POST JSON):
//   { registrationId?: string, pycNumber?: string, email?: string }
//   Provide at least one. registrationId is preferred (most specific).
//
// Returns:
//   {
//     success: true,
//     registrant: { id, first_name, last_name, email, confirmation_number, ... },
//     registrationGroup: [{ ... group members ... }] | null,  // includes the registrant if they're in a group
//     roommateAsRequester: { id, requester_name, requested_members, ... } | null,
//     roommateAsMember: { id, requester_name, requested_members, ... } | null
//   }

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

    const registrationId = (parsed.registrationId || '').trim();
    const pycNumber = (parsed.pycNumber || '').trim().toUpperCase();
    const email = (parsed.email || '').trim().toLowerCase();

    if (!registrationId && !pycNumber && !email) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Provide registrationId, pycNumber, or email' }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Look up the registrant
    let registrantQuery = supabase
      .from('registrations')
      .select('id, first_name, last_name, email, gender, age, confirmation_number, payment_status, group_id, is_primary, registration_type, tshirt_size, meal_plan, phone, region')
      .limit(1);

    if (registrationId) {
      registrantQuery = registrantQuery.eq('id', registrationId);
    } else if (pycNumber) {
      registrantQuery = registrantQuery.eq('confirmation_number', pycNumber);
    } else if (email) {
      registrantQuery = registrantQuery.ilike('email', email).order('is_primary', { ascending: false });
    }

    const { data: regs, error: regErr } = await registrantQuery;

    if (regErr) {
      console.error('Registrant lookup error:', regErr.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to look up registrant' }) };
    }

    if (!regs || regs.length === 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Registrant not found' }) };
    }

    const registrant = regs[0];

    // 1. Conference registration group members (if they have a group_id)
    let registrationGroup = null;
    if (registrant.group_id) {
      const { data: groupMembers } = await supabase
        .from('registrations')
        .select('id, first_name, last_name, email, gender, age, confirmation_number, payment_status, is_primary, tshirt_size, meal_plan')
        .eq('group_id', registrant.group_id)
        .order('is_primary', { ascending: false });
      if (groupMembers && groupMembers.length > 0) {
        registrationGroup = groupMembers;
      }
    }

    // 2. Roommate requests — load all active, then filter
    const { data: allRequests } = await supabase
      .from('roommate_requests')
      .select('id, requester_name, requester_email, requester_pyc, requester_registration_id, requester_gender, requested_members, status, created_at')
      .eq('status', 'Active');

    let roommateAsRequester = null;
    let roommateAsMember = null;

    if (allRequests && allRequests.length > 0) {
      // As requester: match by registration_id OR confirmation_number
      const asRequester = allRequests.find(function(r) {
        if (r.requester_registration_id === registrant.id) return true;
        if (registrant.confirmation_number && r.requester_pyc &&
            r.requester_pyc.toUpperCase() === registrant.confirmation_number.toUpperCase()) return true;
        return false;
      });
      if (asRequester) roommateAsRequester = asRequester;

      // As member: check if their PYC appears in any request's requested_members array
      if (registrant.confirmation_number) {
        const targetPyc = registrant.confirmation_number.toUpperCase();
        const asMember = allRequests.find(function(r) {
          // Skip the one where they're the requester (already captured above)
          if (r.requester_registration_id === registrant.id) return false;
          const members = Array.isArray(r.requested_members) ? r.requested_members : [];
          return members.some(function(m) {
            return m.pycNumber && m.pycNumber.toUpperCase() === targetPyc;
          });
        });
        if (asMember) roommateAsMember = asMember;
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        registrant: registrant,
        registrationGroup: registrationGroup,
        roommateAsRequester: roommateAsRequester,
        roommateAsMember: roommateAsMember
      })
    };
  } catch (err) {
    console.error('admin-registrant-details error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
