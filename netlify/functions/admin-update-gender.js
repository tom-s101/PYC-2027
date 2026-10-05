const { createClient } = require('@supabase/supabase-js');

// Admin tool: change a registrant's gender. Blocks the change if there's any
// downstream conflict (incompatible dorm reservation or room assignment) so
// the admin can clean those up first.
//
// On success: also updates the gender on any active roommate request the person
// owns (requester) so the auto-assign algorithm doesn't filter them out by
// requester_gender.
//
// Input: { registrationId, newGender: 'Male' | 'Female' }
// Output: { success, message } on OK, or { error, conflicts: [...] } if blocked.

const VALID_GENDERS = ['Male', 'Female'];

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

    const registrationId = parsed.registrationId;
    const newGender = (parsed.newGender || '').trim();

    if (!registrationId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'registrationId required' }) };
    }
    if (VALID_GENDERS.indexOf(newGender) === -1) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'newGender must be Male or Female' }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Fetch the registration
    const { data: reg, error: regErr } = await supabase
      .from('registrations')
      .select('id, first_name, last_name, email, gender, confirmation_number')
      .eq('id', registrationId)
      .single();

    if (regErr || !reg) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Registration not found' }) };
    }

    if (reg.gender === newGender) {
      return { statusCode: 200, headers, body: JSON.stringify({
        success: true,
        message: 'Gender is already ' + newGender + '. No change needed.'
      }) };
    }

    // ===== CONFLICT CHECK =====
    // 1. Incompatible accommodation reservation
    // 2. Incompatible room assignment
    const conflicts = [];

    // Check by email AND confirmation_number — accommodations don't always have
    // a registration_id link
    const checks = [];
    checks.push(supabase
      .from('accommodation_reservations')
      .select('id, accommodation_type, payment_status, registrant_name')
      .eq('registrant_email', (reg.email || '').toLowerCase())
      .in('payment_status', ['Pending', 'Pending Review', 'Paid', 'Resubmitted']));

    const [accRes] = await Promise.all(checks);
    const myAccommodations = (accRes && accRes.data) ? accRes.data : [];

    myAccommodations.forEach(function(a) {
      const t = a.accommodation_type;
      // girls_dorm requires Female; boys_dorm requires Male; camping is fine for either
      if (t === 'girls_dorm' && newGender !== 'Female') {
        conflicts.push({
          type: 'accommodation',
          detail: 'Has a Girls\' Dorm reservation but new gender is ' + newGender + '. Cancel the dorm reservation first.'
        });
      }
      if (t === 'boys_dorm' && newGender !== 'Male') {
        conflicts.push({
          type: 'accommodation',
          detail: 'Has a Boys\' Dorm reservation but new gender is ' + newGender + '. Cancel the dorm reservation first.'
        });
      }
    });

    // Room assignments: search by PYC inside the members JSON array
    const pyc = (reg.confirmation_number || '').toUpperCase();
    if (pyc) {
      const { data: rooms } = await supabase
        .from('room_assignments')
        .select('id, hall, room_number, gender, members, is_locked');
      (rooms || []).forEach(function(room) {
        const inRoom = (room.members || []).some(function(m) {
          return (m.pycNumber || '').toUpperCase() === pyc;
        });
        if (inRoom && room.gender && room.gender !== newGender) {
          conflicts.push({
            type: 'room_assignment',
            detail: 'Currently assigned to ' + room.hall + ' Room ' + room.room_number +
              ' (' + room.gender + ' hall)' + (room.is_locked ? ' — locked group' : '') +
              '. Run "Reset Assignments" or remove this person from the room first.'
          });
        }
      });
    }

    if (conflicts.length > 0) {
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({
          error: 'Cannot change gender — there are ' + conflicts.length + ' conflict(s) to resolve first.',
          conflicts: conflicts
        })
      };
    }

    // ===== APPLY CHANGE =====
    const { error: updErr } = await supabase
      .from('registrations')
      .update({ gender: newGender })
      .eq('id', registrationId);

    if (updErr) {
      console.error('Gender update error:', updErr.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to update gender: ' + updErr.message }) };
    }

    // Also update any active roommate request where this person is the requester
    let roommateUpdates = 0;
    if (pyc) {
      const { data: rrUpd, error: rrErr } = await supabase
        .from('roommate_requests')
        .update({ requester_gender: newGender })
        .eq('requester_pyc', pyc)
        .eq('status', 'Active')
        .select();
      if (rrErr) {
        console.warn('Roommate request gender update warning:', rrErr.message);
      } else {
        roommateUpdates = (rrUpd || []).length;
      }
    }

    const fullName = ((reg.first_name || '') + ' ' + (reg.last_name || '')).trim();
    let msg = 'Gender for ' + fullName + ' changed from ' + (reg.gender || 'unset') + ' to ' + newGender + '.';
    if (roommateUpdates > 0) msg += ' (Also updated ' + roommateUpdates + ' active roommate request' + (roommateUpdates === 1 ? '' : 's') + '.)';

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, message: msg })
    };
  } catch (err) {
    console.error('admin-update-gender error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error: ' + err.message }) };
  }
};
