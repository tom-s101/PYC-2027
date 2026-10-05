const { createClient } = require('@supabase/supabase-js');

// Admin tool: edit a registrant's gender and/or meal plan.
// Each field is updated independently — if the gender change is blocked by a
// conflict, the meal plan can still update (and vice versa).
//
// Input (POST JSON):
//   { registrationId, newGender? (Male|Female), newMealPlan? (vegan|vegetarian|none) }
//
// Output (200):
//   {
//     success: true,
//     genderUpdated: bool, genderError?: string, genderConflicts?: [...],
//     mealPlanUpdated: bool, mealPlanError?: string,
//     message: 'human-readable summary'
//   }

const VALID_GENDERS = ['Male', 'Female'];
const VALID_MEAL_PLANS = ['vegan', 'vegetarian', 'none'];

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
    const newGender = parsed.newGender ? String(parsed.newGender).trim() : null;
    const newMealPlan = parsed.newMealPlan ? String(parsed.newMealPlan).trim() : null;
    // Admin override: if true, skip the email-based dorm conflict check. Used for
    // group members where the shared email triggers false-positive conflicts,
    // or for any case where the admin is certain the person has no dorm reservation
    // of their own. The room_assignment conflict check still runs — that one is
    // about the specific person's actual room placement and can't be bypassed.
    const forceOverride = parsed.forceOverride === true;

    if (!registrationId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'registrationId required' }) };
    }
    if (!newGender && !newMealPlan) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Nothing to update — provide newGender, newMealPlan, or both' }) };
    }
    if (newGender && VALID_GENDERS.indexOf(newGender) === -1) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'newGender must be Male or Female' }) };
    }
    if (newMealPlan && VALID_MEAL_PLANS.indexOf(newMealPlan) === -1) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'newMealPlan must be vegan, vegetarian, or none' }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Fetch the registration
    const { data: reg, error: regErr } = await supabase
      .from('registrations')
      .select('id, first_name, last_name, email, gender, meal_plan, confirmation_number, group_id')
      .eq('id', registrationId)
      .single();

    if (regErr || !reg) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Registration not found' }) };
    }

    const result = {
      genderUpdated: false,
      genderError: null,
      genderConflicts: null,
      mealPlanUpdated: false,
      mealPlanError: null,
      messages: []
    };

    const fullName = ((reg.first_name || '') + ' ' + (reg.last_name || '')).trim();

    // ===== GENDER UPDATE (with conflict check) =====
    if (newGender) {
      if (newGender === reg.gender) {
        result.messages.push('Gender already ' + newGender + ' — no change.');
      } else {
        const conflicts = [];

        // Check accommodation reservations by email — but ONLY for solo registrants
        // who are not being force-overridden. For group registrations, all members
        // share the primary registrant's email, and the group can legitimately have
        // BOTH boys_dorm and girls_dorm reservations (e.g. a family with both sons
        // and daughters). Applying the email-based check to group members would
        // incorrectly block valid gender assignments. The dorm type is bound to
        // the GROUP, not to any individual member. The forceOverride flag is the
        // escape hatch for any remaining edge cases where the data is inconsistent
        // (e.g. group member missing group_id).
        if (!reg.group_id && !forceOverride) {
          const { data: accList } = await supabase
            .from('accommodation_reservations')
            .select('id, accommodation_type, payment_status')
            .eq('registrant_email', (reg.email || '').toLowerCase())
            .in('payment_status', ['Pending', 'Pending Review', 'Paid', 'Resubmitted']);

          (accList || []).forEach(function(a) {
            if (a.accommodation_type === 'girls_dorm' && newGender !== 'Female') {
              conflicts.push({
                type: 'accommodation',
                detail: 'Has a Girls\' Dorm reservation but new gender is ' + newGender + '. Cancel the dorm reservation first.'
              });
            }
            if (a.accommodation_type === 'boys_dorm' && newGender !== 'Male') {
              conflicts.push({
                type: 'accommodation',
                detail: 'Has a Boys\' Dorm reservation but new gender is ' + newGender + '. Cancel the dorm reservation first.'
              });
            }
          });
        }

        // Check room assignments by PYC inside members JSON
        const pyc = (reg.confirmation_number || '').toUpperCase();
        if (pyc) {
          const { data: rooms } = await supabase
            .from('room_assignments')
            .select('hall, room_number, gender, members, is_locked');
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
          result.genderError = 'Cannot change gender — ' + conflicts.length + ' conflict(s).';
          result.genderConflicts = conflicts;
          result.messages.push('Gender NOT updated: ' + conflicts.length + ' conflict(s).');
        } else {
          const { error: updErr } = await supabase
            .from('registrations')
            .update({ gender: newGender })
            .eq('id', registrationId);

          if (updErr) {
            result.genderError = updErr.message;
            result.messages.push('Gender update failed: ' + updErr.message);
          } else {
            result.genderUpdated = true;
            result.messages.push('Gender changed to ' + newGender + '.');

            // Also update any active roommate request where this person is the requester
            if (pyc) {
              const { data: rrUpd } = await supabase
                .from('roommate_requests')
                .update({ requester_gender: newGender })
                .eq('requester_pyc', pyc)
                .eq('status', 'Active')
                .select();
              const n = (rrUpd || []).length;
              if (n > 0) result.messages.push('Updated ' + n + ' active roommate request' + (n === 1 ? '' : 's') + '.');
            }
          }
        }
      }
    }

    // ===== MEAL PLAN UPDATE (no conflict check, no price recalc) =====
    if (newMealPlan) {
      if (newMealPlan === reg.meal_plan) {
        result.messages.push('Meal plan already ' + newMealPlan + ' — no change.');
      } else {
        const { error: mealErr } = await supabase
          .from('registrations')
          .update({ meal_plan: newMealPlan })
          .eq('id', registrationId);

        if (mealErr) {
          result.mealPlanError = mealErr.message;
          result.messages.push('Meal plan update failed: ' + mealErr.message);
        } else {
          result.mealPlanUpdated = true;
          result.messages.push('Meal plan changed to ' + newMealPlan + '.');
        }
      }
    }

    // success: at least one requested update succeeded OR every requested change was a no-op
    const noopGender = !newGender || newGender === reg.gender;
    const noopMeal = !newMealPlan || newMealPlan === reg.meal_plan;
    const successFlag = result.genderUpdated || result.mealPlanUpdated || (noopGender && noopMeal);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: successFlag,
        genderUpdated: result.genderUpdated,
        genderError: result.genderError,
        genderConflicts: result.genderConflicts,
        mealPlanUpdated: result.mealPlanUpdated,
        mealPlanError: result.mealPlanError,
        message: fullName + ': ' + result.messages.join(' ')
      })
    };
  } catch (err) {
    console.error('admin-update-registration error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error: ' + err.message }) };
  }
};
