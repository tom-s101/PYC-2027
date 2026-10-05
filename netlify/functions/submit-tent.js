const { createClient } = require('@supabase/supabase-js');

const TOTAL_CANOPIES = 10;
const TENTS_PER_CANOPY = 40;

// Accommodation reservations (including tents) close: end of May 22, 2026
// Philippine Time (11:59 PM PHT) = May 22 15:59 UTC. Fully server-side.
const ACCOMMODATION_CLOSE_AT = Date.UTC(2026, 4, 22, 15, 59, 59);

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    let parsed;
    try { parsed = JSON.parse(event.body); } catch (e) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) };
    }

    // ===== ACCOMMODATION CUTOFF CHECK (tents included) =====
    // Reservations close at the end of May 22, 2026 Philippine Time (11:59 PM PHT).
    // Fully server-side. Admin-bypass token accepted for late reservations.
    if (Date.now() >= ACCOMMODATION_CLOSE_AT) {
      const providedToken = (parsed.adminBypassToken || '').toString();
      const expectedToken = process.env.ADMIN_REG_BYPASS_TOKEN || '';
      const bypassOk = expectedToken.length > 0 && providedToken === expectedToken;
      if (!bypassOk) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({
            error: 'Accommodation reservations are closed. Reservations ended on May 22, 2026 (Philippine Time). Please contact the PYC team if you need help.',
            accommodationClosed: true
          })
        };
      }
      console.log('Admin bypass used for post-close tent reservation');
    }

    const { registrationId, registrantName, registrantEmail, tents } = parsed;

    if (!registrantEmail || !registrantName) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Name and email required' }) };
    }
    if (!tents || !Array.isArray(tents) || tents.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'At least one tent is required' }) };
    }

    // Solo-tent whitelist: specific PYCs are allowed to reserve a tent with just 1 person.
    // This is for people who have no one to tent with but still need accommodation.
    // Keep this list small and update as needed.
    const SOLO_TENT_WHITELIST = ['PYC-0688', 'PYC-0760', 'PYC-0721', 'PYC-0622', 'PYC-0970', 'PYC-0971', 'PYC-0419', 'PYC-1123', 'PYC-0810'];

    // Multi-tent whitelist: specific PYCs are allowed to appear in MORE THAN ONE tent
    // reservation. Normally the system blocks a PYC from appearing in two separate
    // tent submissions (to prevent double-booking). People on this list are explicitly
    // allowed to reserve multiple tents — e.g. a group leader who splits a party of 4
    // into two 2-person tents rather than one 4-person tent.
    const MULTI_TENT_WHITELIST = ['PYC-1029'];

    // Check whether any of the tent's members is on the solo-tent whitelist
    function tentHasWhitelistedMember(tent) {
      if (!tent.members || !Array.isArray(tent.members)) return false;
      return tent.members.some(function(m) {
        const pyc = (m && m.pycNumber ? String(m.pycNumber) : '').toUpperCase();
        return SOLO_TENT_WHITELIST.indexOf(pyc) !== -1;
      });
    }

    const VALID_GROUP_TYPES = ['solo', 'married', 'family', 'friends'];

    // Validate each tent
    for (const tent of tents) {
      // Solo tenting is now open to EVERYONE: minimum tent size is 1, and a tent
      // may have just 1 member. (Previously restricted to SOLO_TENT_WHITELIST.)
      const minTentSize = 1;
      if (!tent.tentSize || tent.tentSize < minTentSize || tent.tentSize > 4) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Tent size must be between 1 and 4 people' }) };
      }
      if (!tent.members || !Array.isArray(tent.members) || tent.members.length < 1) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Each tent must have at least 1 member' }) };
      }
      if (tent.members.length > tent.tentSize) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Too many members for tent size' }) };
      }
      // Group type is required (must be one of solo/married/family/friends)
      if (!tent.groupType || VALID_GROUP_TYPES.indexOf(tent.groupType) === -1) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please select a group type (Solo, Married, Family, or Friends) for each tent.' }) };
      }
      // A solo tent must be exactly 1 person; a 1-person tent must be solo.
      if (tent.groupType === 'solo' && tent.tentSize !== 1) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'A Solo tent is for 1 person only. Pick the 1-Person size, or choose a different group type.' }) };
      }
      if (tent.tentSize === 1 && tent.groupType !== 'solo') {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'A 1-person tent must use the Solo group type.' }) };
      }
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // STALE CLEANUP: Delete any old Pending tent reservations from this same email.
    // These are stale records from abandoned reservations — the user is now re-trying.
    // We only delete Pending (no proof uploaded) — never touch Pending Review/Resubmitted/Paid.
    if (registrantEmail) {
      const { error: cleanupErr } = await supabase
        .from('tent_reservations')
        .delete()
        .eq('registrant_email', registrantEmail)
        .eq('payment_status', 'Pending');
      if (cleanupErr) {
        console.warn('Stale tent cleanup warning:', cleanupErr.message);
        // Don't fail the request on cleanup errors — just log
      }
    }

    // Check if any of the members already have a tent reservation WITH PROOF UPLOADED.
    // We only block on Pending Review / Resubmitted / Paid — not bare Pending (abandoned).
    const allMemberPycs = [];
    for (const tent of tents) {
      for (const m of tent.members) {
        if (m.pycNumber) allMemberPycs.push(m.pycNumber);
      }
    }

    if (allMemberPycs.length > 0) {
      const { data: existingTents } = await supabase
        .from('tent_reservations')
        .select('members, registrant_name, payment_status')
        .eq('status', 'Active')
        .in('payment_status', ['Pending Review', 'Resubmitted', 'Paid']);

      if (existingTents && existingTents.length > 0) {
        for (const existing of existingTents) {
          const existingMembers = Array.isArray(existing.members) ? existing.members : [];
          for (const em of existingMembers) {
            if (!em.pycNumber || !allMemberPycs.includes(em.pycNumber)) continue;
            // Skip the duplicate check for PYCs on the multi-tent whitelist —
            // they are explicitly allowed to appear in more than one tent reservation.
            const pyc = String(em.pycNumber).toUpperCase();
            if (MULTI_TENT_WHITELIST.indexOf(pyc) !== -1) continue;
            return { statusCode: 409, headers, body: JSON.stringify({
              error: `${em.name || em.pycNumber} already has a tent reservation made by ${existing.registrant_name}. They do not need to reserve again.`
            }) };
          }
        }
      }
    }

    // Get current canopy occupancy to auto-assign.
    // Keep 'Pending' here so canopy slots held by recent submissions aren't double-assigned
    // during the brief window before proof upload. Stale Pending records have already been
    // cleaned up above for this registrant.
    const { data: activeTents, error: countErr } = await supabase
      .from('tent_reservations')
      .select('canopy_number, tent_group_type')
      .eq('status', 'Active')
      .in('payment_status', ['Pending', 'Pending Review', 'Resubmitted', 'Paid']);

    if (countErr) {
      console.error('Count error:', countErr.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
    }

    // Count tents per canopy + track group type distribution within each canopy.
    // canopyCounts[n] = number of tents, canopyTypes[n] = { solo, married, family, friends }
    const canopyCounts = {};
    const canopyTypes = {};
    for (let i = 1; i <= TOTAL_CANOPIES; i++) {
      canopyCounts[i] = 0;
      canopyTypes[i] = { solo: 0, married: 0, family: 0, friends: 0, unknown: 0 };
    }
    if (activeTents) {
      for (const t of activeTents) {
        const n = t.canopy_number;
        canopyCounts[n] = (canopyCounts[n] || 0) + 1;
        if (!canopyTypes[n]) canopyTypes[n] = { solo: 0, married: 0, family: 0, friends: 0, unknown: 0 };
        const gt = t.tent_group_type;
        if (gt === 'solo' || gt === 'married' || gt === 'family' || gt === 'friends') canopyTypes[n][gt] += 1;
        else canopyTypes[n].unknown += 1;
      }
    }

    // Check total availability
    const totalUsed = activeTents ? activeTents.length : 0;
    const totalAvailable = (TOTAL_CANOPIES * TENTS_PER_CANOPY) - totalUsed;
    if (tents.length > totalAvailable) {
      return { statusCode: 409, headers, body: JSON.stringify({
        error: `Only ${totalAvailable} tent space(s) available. You requested ${tents.length}.`
      }) };
    }

    // Generate a group_id so all tents in this submission can be linked
    const groupId = require('crypto').randomUUID();
    const PRICE_PER_PERSON = 150;

    // Auto-assign canopies. Strategy (grouping by tent_group_type):
    //   1. Find a canopy that already has tents of the same group type AND has space.
    //      Prefer the one with the most same-type tents (denser cluster).
    //   2. If none exists, fall back to the first empty/lowest-numbered canopy with space.
    //   This means "married" tents cluster together, "family" tents cluster, etc.
    const createdReservations = [];
    for (const tent of tents) {
      let assignedCanopy = null;

      // Pass 1: find canopy with same type + space
      let bestCanopy = null;
      let bestTypeCount = 0;
      for (let i = 1; i <= TOTAL_CANOPIES; i++) {
        if (canopyCounts[i] >= TENTS_PER_CANOPY) continue;
        const sameTypeCount = canopyTypes[i][tent.groupType] || 0;
        if (sameTypeCount > bestTypeCount) {
          bestTypeCount = sameTypeCount;
          bestCanopy = i;
        }
      }
      if (bestCanopy) assignedCanopy = bestCanopy;

      // Pass 2: fall back to first empty/lowest-numbered canopy
      if (!assignedCanopy) {
        for (let i = 1; i <= TOTAL_CANOPIES; i++) {
          if (canopyCounts[i] < TENTS_PER_CANOPY) {
            assignedCanopy = i;
            break;
          }
        }
      }

      if (!assignedCanopy) {
        return { statusCode: 409, headers, body: JSON.stringify({ error: 'All canopy spaces are full.' }) };
      }

      const tentTotal = (tent.members ? tent.members.length : 0) * PRICE_PER_PERSON;

      const { data: newRes, error: insertErr } = await supabase
        .from('tent_reservations')
        .insert([{
          registration_id: registrationId || null,
          registrant_name: registrantName,
          registrant_email: registrantEmail,
          tent_size: tent.tentSize,
          members: tent.members,
          canopy_number: assignedCanopy,
          tent_group_type: tent.groupType,
          status: 'Active',
          payment_status: 'Pending',
          price_per_person: PRICE_PER_PERSON,
          total_amount: tentTotal,
          group_id: groupId
        }])
        .select()
        .single();

      if (insertErr) {
        console.error('Tent insert error:', insertErr.message);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to create tent reservation' }) };
      }

      canopyCounts[assignedCanopy]++;
      canopyTypes[assignedCanopy][tent.groupType] = (canopyTypes[assignedCanopy][tent.groupType] || 0) + 1;
      createdReservations.push({
        id: newRes.id,
        tentSize: tent.tentSize,
        members: tent.members,
        canopyNumber: assignedCanopy,
        totalAmount: tentTotal
      });
    }

    const grandTotal = createdReservations.reduce(function(s,r){return s+(r.totalAmount||0);}, 0);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: createdReservations.length + ' tent(s) reserved. Please proceed to payment.',
        reservations: createdReservations,
        groupId: groupId,
        grandTotal: grandTotal,
        pricePerPerson: PRICE_PER_PERSON
      })
    };
  } catch (err) {
    console.error('Submit tent error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
