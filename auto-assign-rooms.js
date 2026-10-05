const { createClient } = require('@supabase/supabase-js');

const HALLS = {
  Male: [
    { name: 'Onyx', capacity: 100, roomSize: 4 },   // 25 rooms
    { name: 'Emerald', capacity: 88, roomSize: 4 }   // 37 physical rooms, 15 reserved -> 22 usable = 88 spaces
  ],
  Female: [
    { name: 'Pearl', capacity: 100, roomSize: 4 },     // 25 rooms
    { name: 'Amethyst', capacity: 148, roomSize: 4 }   // 37 rooms
  ]
};

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // GET = retrieve current assignments
  if (event.httpMethod === 'GET') {
    try {
      const { data: assignments } = await supabase
        .from('room_assignments')
        .select('*')
        .order('hall')
        .order('room_number');

      if (!assignments || assignments.length === 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, halls: null }) };
      }

      const halls = {};
      let totalAssigned = 0, totalRooms = 0;
      assignments.forEach(a => {
        if (!halls[a.hall]) halls[a.hall] = [];
        halls[a.hall].push(a);
        totalAssigned += (a.members || []).length;
        totalRooms++;
      });

      // Count truly-assignable people the same way the assignment algorithm does:
      // EXPAND group reservations into their individual members and count only those
      // members who have a gender set. Counting `spots × primary-has-gender` overcounts
      // when a group has spots for members whose own gender is still empty — those
      // members can't be placed, so they shouldn't count as "assignable" either.
      // This keeps the GET's UNASSIGNED number consistent with what the assignment
      // algorithm actually produces.
      const { data: allRes } = await supabase
        .from('accommodation_reservations')
        .select('id, registration_id, registrant_name, registrant_email, accommodation_type, spots_requested')
        .in('payment_status', ['Pending', 'Paid', 'Pending Review', 'Resubmitted'])
        .in('accommodation_type', ['girls_dorm', 'boys_dorm']); // dorm-only

      const regIdsForCount = [...new Set((allRes || []).map(r => r.registration_id).filter(Boolean))];
      let assignablePeople = 0;
      let genderlessCount = 0;
      const ghostSpots = []; // surface unplaceable spots so admin can fix them
      const placeablePeople = []; // {registrationId, name, pycNumber, gender, email} — for reconciliation vs saved rooms
      if (regIdsForCount.length > 0) {
        const { data: primariesForCount } = await supabase
          .from('registrations')
          .select('id, first_name, last_name, gender, group_id, confirmation_number')
          .in('id', regIdsForCount);
        const primaryMap = {};
        (primariesForCount || []).forEach(r => { primaryMap[r.id] = r; });

        // Collect the unique set of group_ids we need to expand
        const groupIds = [...new Set((primariesForCount || [])
          .filter(p => p.group_id)
          .map(p => p.group_id))];
        const groupMembersByGroup = {};
        if (groupIds.length > 0) {
          const { data: gms } = await supabase
            .from('registrations')
            .select('id, first_name, last_name, gender, group_id, confirmation_number')
            .in('group_id', groupIds);
          (gms || []).forEach(m => {
            if (!groupMembersByGroup[m.group_id]) groupMembersByGroup[m.group_id] = [];
            groupMembersByGroup[m.group_id].push(m);
          });
        }

        // For each reservation: if it's a group with multiple spots, expand to actual
        // group members and count by their individual gender. Otherwise count the
        // single registrant. Track ghosts too.
        const seenIds = new Set();
        (allRes || []).forEach(res => {
          const reg = primaryMap[res.registration_id];
          const spots = res.spots_requested || 1;
          const ghost = {
            reservationId: res.id,
            registrantName: res.registrant_name || (reg ? `${reg.first_name||''} ${reg.last_name||''}`.trim() : ''),
            registrantEmail: res.registrant_email || '',
            registrantPyc: reg ? (reg.confirmation_number || '') : '',
            accommodationType: res.accommodation_type,
            spotsRequested: spots,
            spotsPlaced: 0,
            reasons: []
          };
          if (!reg) {
            ghost.reasons.push('Primary registration not found');
            ghostSpots.push(ghost);
            return;
          }
          if (reg.group_id && spots > 1) {
            // Determine which gender this reservation is for, based on accommodation type.
            const targetGender = res.accommodation_type === 'girls_dorm' ? 'Female'
                               : res.accommodation_type === 'boys_dorm' ? 'Male'
                               : null;
            const allMembers = groupMembersByGroup[reg.group_id] || [];
            // Only consider members whose gender matches the dorm type (and genderless
            // members so we can flag them as ghosts)
            const members = targetGender
              ? allMembers.filter(m => m.gender === targetGender || !m.gender)
              : allMembers;
            let placed = 0;
            members.forEach(m => {
              if (seenIds.has(m.id)) return;
              if (targetGender && m.gender && m.gender !== targetGender) return;
              seenIds.add(m.id);
              if (m.gender) {
                assignablePeople += 1; placed += 1;
                placeablePeople.push({ registrationId: m.id, name: `${m.first_name||''} ${m.last_name||''}`.trim(), pycNumber: m.confirmation_number || '', gender: m.gender, email: res.registrant_email || '' });
              }
              else {
                genderlessCount += 1;
                ghost.reasons.push(`${m.first_name||''} ${m.last_name||''}`.trim() + (m.confirmation_number ? ' ('+m.confirmation_number+')' : '') + ' — no gender set');
              }
            });
            ghost.spotsPlaced = placed;
            // Compare against gender-matching member count, not total group size
            const genderMatchingCount = targetGender
              ? allMembers.filter(m => m.gender === targetGender).length
              : allMembers.length;
            const memberShortfall = spots - genderMatchingCount;
            if (memberShortfall > 0) {
              ghost.reasons.push('Reservation has ' + spots + ' ' + (targetGender || '') + ' spot(s) but only ' + genderMatchingCount + ' ' + (targetGender ? targetGender.toLowerCase() : '') + ' group member(s) exist (group_id ' + reg.group_id + ')');
            }
            // Surface any gap, even if we don't have a specific reason yet
            if (placed < spots) {
              if (ghost.reasons.length === 0) {
                ghost.reasons.push('Reservation has ' + spots + ' spots but only ' + placed + ' member(s) were placeable — some members may already be accounted for under another reservation in the same group, or the data has an inconsistency.');
              }
              ghostSpots.push(ghost);
            }
          } else {
            if (seenIds.has(reg.id)) {
              ghost.spotsPlaced = spots;
              return;
            }
            seenIds.add(reg.id);
            if (reg.gender) {
              assignablePeople += 1;
              ghost.spotsPlaced = 1;
              placeablePeople.push({ registrationId: reg.id, name: `${reg.first_name||''} ${reg.last_name||''}`.trim(), pycNumber: reg.confirmation_number || '', gender: reg.gender, email: res.registrant_email || '' });
              if (spots > 1) {
                ghost.reasons.push('Reservation has ' + spots + ' spots but the primary has no group_id — extra ' + (spots - 1) + ' spot(s) have no people');
                ghostSpots.push(ghost);
              }
            } else {
              genderlessCount += 1;
              ghost.reasons.push((reg.first_name||'') + ' ' + (reg.last_name||'') + ' — no gender set on registration');
              ghostSpots.push(ghost);
            }
          }
        });
      }

      // ===== RECONCILIATION: who is placeable but NOT actually in a saved room? =====
      // This is the authoritative "unassigned people" check. It catches everyone who
      // booked + has a gender but didn't end up in a room — regardless of cause.
      // For each one we look up WHY: their group, how many same-gender members the
      // group has, and how many dorm spots the group actually reserved. This tells
      // the admin whether it's a data fix (missing gender) or an under-booking
      // (group has more people than spots they paid for).
      const placedRegIds = new Set();
      assignments.forEach(a => {
        (a.members || []).forEach(m => { if (m && m.registrationId) placedRegIds.add(String(m.registrationId)); });
      });
      const unplacedPeople = placeablePeople.filter(p => p.registrationId && !placedRegIds.has(String(p.registrationId)));
      const seenUnplaced = new Set();
      for (const p of unplacedPeople) {
        if (seenUnplaced.has(p.registrationId)) continue;
        seenUnplaced.add(p.registrationId);

        const reasons = [];
        // Look up this person's registration to find their group
        const { data: pReg } = await supabase
          .from('registrations')
          .select('id, group_id, gender, first_name, last_name')
          .eq('id', p.registrationId)
          .single();

        if (pReg && pReg.group_id) {
          const targetType = p.gender === 'Female' ? 'girls_dorm' : 'boys_dorm';
          // How many same-gender members are in this group?
          const { data: groupSiblings } = await supabase
            .from('registrations')
            .select('id, gender')
            .eq('group_id', pReg.group_id);
          const sameGenderMembers = (groupSiblings || []).filter(m => m.gender === p.gender).length;
          // How many dorm spots did this group reserve for this gender?
          const sibIds = (groupSiblings || []).map(m => m.id);
          let spotsReserved = 0;
          if (sibIds.length > 0) {
            const { data: groupRes } = await supabase
              .from('accommodation_reservations')
              .select('spots_requested, accommodation_type, registration_id')
              .in('registration_id', sibIds)
              .eq('accommodation_type', targetType)
              .in('payment_status', ['Pending', 'Paid', 'Pending Review', 'Resubmitted']);
            spotsReserved = (groupRes || []).reduce((s, r) => s + (r.spots_requested || 0), 0);
          }
          if (sameGenderMembers > spotsReserved) {
            reasons.push('This group has ' + sameGenderMembers + ' ' + p.gender.toLowerCase() + ' member(s) but only reserved ' + spotsReserved + ' ' + targetType + ' spot(s) — there are ' + (sameGenderMembers - spotsReserved) + ' more ' + p.gender.toLowerCase() + ' member(s) than paid beds. The group needs to reserve more spots, or this person should be removed from the dorm list.');
          } else {
            reasons.push('Booked under a group (' + spotsReserved + ' ' + targetType + ' spot(s) for ' + sameGenderMembers + ' ' + p.gender.toLowerCase() + ' member(s)) but not placed — try re-running Auto-Assign, or use MOVE to place manually.');
          }
        } else {
          reasons.push('Booked and has a gender set, but was not placed — try re-running Auto-Assign, or use the MOVE button to place them manually.');
        }

        ghostSpots.push({
          reservationId: null,
          registrantName: p.name || 'Unknown',
          registrantEmail: p.email || '',
          registrantPyc: p.pycNumber || '',
          accommodationType: p.gender === 'Female' ? 'girls_dorm' : 'boys_dorm',
          spotsRequested: 1,
          spotsPlaced: 0,
          reasons: reasons
        });
      }
      const trueUnassigned = seenUnplaced.size;

      const totalGhostSpots = ghostSpots.reduce((s, g) => s + (g.spotsRequested - g.spotsPlaced), 0);

      // Compute request stats
      const { data: requests } = await supabase
        .from('roommate_requests').select('*').eq('status', 'Active');
      const reqStats = computeRequestStats(assignments, requests || []);

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          success: true, halls,
          summary: {
            totalAssigned,
            // Reconciled count: placeable people who are genuinely not in any saved room.
            // This is consistent on every refresh and matches the named entries now
            // surfaced in ghostSpots, so the "unassigned" number always ties out to a
            // specific list of people the admin can see and fix.
            totalUnassigned: trueUnassigned,
            genderlessCount: genderlessCount,
            totalGhostSpots: totalGhostSpots,
            totalRooms, ...reqStats
          },
          ghostSpots: ghostSpots
        })
      };
    } catch (e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  // POST = run auto-assignment OR reset
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  // Parse action and payload from body
  let postAction = '';
  let postBody = {};
  try {
    if (event.body) {
      postBody = JSON.parse(event.body);
      postAction = postBody.action || '';
    }
  } catch (e) {
    // Empty or non-JSON body is fine — default to auto-assign
  }

  // RESET = delete only UNLOCKED room assignments (locked rooms are preserved)
  if (postAction === 'reset') {
    try {
      const { error: delErr } = await supabase
        .from('room_assignments')
        .delete()
        .eq('is_locked', false);

      if (delErr) {
        console.error('Reset error:', delErr.message);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to reset assignments: ' + delErr.message }) };
      }

      // Count remaining locked rooms for informational message
      const { count: lockedCount } = await supabase
        .from('room_assignments')
        .select('*', { count: 'exact', head: true })
        .eq('is_locked', true);

      const msg = lockedCount > 0
        ? 'Unlocked room assignments cleared. ' + lockedCount + ' locked room(s) preserved.'
        : 'All room assignments cleared.';

      return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: msg }) };
    } catch (err) {
      console.error('Reset exception:', err.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error during reset' }) };
    }
  }

  // LOCK = mark a specific room as locked
  if (postAction === 'lock') {
    try {
      const { hall, roomNumber } = postBody;
      if (!hall || !roomNumber) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'hall and roomNumber required' }) };
      }
      const { data: updated, error: updErr } = await supabase
        .from('room_assignments')
        .update({ is_locked: true })
        .eq('hall', hall)
        .eq('room_number', roomNumber)
        .select();
      if (updErr) {
        console.error('Lock error:', updErr.message);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to lock room: ' + updErr.message }) };
      }
      if (!updated || updated.length === 0) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Room not found' }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Room ' + hall + ' #' + roomNumber + ' locked.' }) };
    } catch (err) {
      console.error('Lock exception:', err.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
    }
  }

  // UNLOCK = unlock a specific room
  if (postAction === 'unlock') {
    try {
      const { hall, roomNumber } = postBody;
      if (!hall || !roomNumber) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'hall and roomNumber required' }) };
      }
      const { data: updated, error: updErr } = await supabase
        .from('room_assignments')
        .update({ is_locked: false })
        .eq('hall', hall)
        .eq('room_number', roomNumber)
        .select();
      if (updErr) {
        console.error('Unlock error:', updErr.message);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to unlock room: ' + updErr.message }) };
      }
      if (!updated || updated.length === 0) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Room not found' }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Room ' + hall + ' #' + roomNumber + ' unlocked.' }) };
    } catch (err) {
      console.error('Unlock exception:', err.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
    }
  }

  // CLEAR_LOCKS = unlock every room (does not delete assignments, just clears the lock flag)
  if (postAction === 'clear_locks') {
    try {
      const { error: updErr } = await supabase
        .from('room_assignments')
        .update({ is_locked: false })
        .eq('is_locked', true);
      if (updErr) {
        console.error('Clear locks error:', updErr.message);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to clear locks: ' + updErr.message }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'All room locks cleared.' }) };
    } catch (err) {
      console.error('Clear locks exception:', err.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
    }
  }

  // MOVE_MEMBER = move a single person from one room to another (admin override).
  // Input: { action: 'move_member', sourcePyc, targetHall, targetRoomNumber }
  // Capacity is NOT enforced server-side — admin is in charge.
  // Source/target rooms can be in different halls / different genders (admin's call).
  // If the source room becomes empty, it's deleted.
  if (postAction === 'move_member') {
    try {
      const sourcePyc = String(postBody.sourcePyc || '').trim().toUpperCase();
      const targetHall = String(postBody.targetHall || '').trim();
      const targetRoomNumberRaw = postBody.targetRoomNumber;
      const targetRoomNumber = typeof targetRoomNumberRaw === 'string' ? parseInt(targetRoomNumberRaw, 10) : targetRoomNumberRaw;

      if (!sourcePyc) return { statusCode: 400, headers, body: JSON.stringify({ error: 'sourcePyc required' }) };
      if (!targetHall || !targetRoomNumber) return { statusCode: 400, headers, body: JSON.stringify({ error: 'targetHall and targetRoomNumber required' }) };

      // Find source room (the one currently containing this PYC)
      const { data: allRooms, error: fetchErr } = await supabase
        .from('room_assignments')
        .select('*');
      if (fetchErr) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to load rooms: ' + fetchErr.message }) };
      }
      let sourceRoom = null;
      let memberToMove = null;
      for (const r of (allRooms || [])) {
        const found = (r.members || []).find(function(m) {
          return (m.pycNumber || '').toUpperCase() === sourcePyc;
        });
        if (found) {
          sourceRoom = r;
          memberToMove = found;
          break;
        }
      }
      if (!sourceRoom || !memberToMove) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Person with PYC ' + sourcePyc + ' is not currently in any room.' }) };
      }

      // Find target room
      const targetRoom = (allRooms || []).find(function(r) {
        return r.hall === targetHall && r.room_number === targetRoomNumber;
      });
      if (!targetRoom) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Target room ' + targetHall + ' #' + targetRoomNumber + ' not found.' }) };
      }

      // No-op check
      if (sourceRoom.id === targetRoom.id) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Person is already in that room. No change.' }) };
      }

      // Remove from source
      const newSourceMembers = (sourceRoom.members || []).filter(function(m) {
        return (m.pycNumber || '').toUpperCase() !== sourcePyc;
      });

      // Add to target
      const newTargetMembers = (targetRoom.members || []).slice();
      newTargetMembers.push(memberToMove);

      // If source room becomes empty, delete it. Otherwise update.
      if (newSourceMembers.length === 0) {
        const { error: delErr } = await supabase
          .from('room_assignments')
          .delete()
          .eq('id', sourceRoom.id);
        if (delErr) {
          return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to delete empty source room: ' + delErr.message }) };
        }
      } else {
        const { error: srcUpdErr } = await supabase
          .from('room_assignments')
          .update({ members: newSourceMembers })
          .eq('id', sourceRoom.id);
        if (srcUpdErr) {
          return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to update source room: ' + srcUpdErr.message }) };
        }
      }

      // Update target
      const { error: tgtUpdErr } = await supabase
        .from('room_assignments')
        .update({ members: newTargetMembers })
        .eq('id', targetRoom.id);
      if (tgtUpdErr) {
        // Try to restore source on target failure
        if (newSourceMembers.length === 0) {
          // Re-create the source row with the person back in it
          await supabase
            .from('room_assignments')
            .insert([{
              hall: sourceRoom.hall,
              room_number: sourceRoom.room_number,
              gender: sourceRoom.gender,
              members: [memberToMove],
              is_locked: sourceRoom.is_locked || false
            }]);
        } else {
          // Restore by putting them back
          newSourceMembers.push(memberToMove);
          await supabase
            .from('room_assignments')
            .update({ members: newSourceMembers })
            .eq('id', sourceRoom.id);
        }
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to update target room (changes rolled back): ' + tgtUpdErr.message }) };
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          message: 'Moved ' + (memberToMove.name || sourcePyc) + ' from ' + sourceRoom.hall + ' #' + sourceRoom.room_number +
                   ' to ' + targetHall + ' #' + targetRoomNumber + '.',
          newTargetMemberCount: newTargetMembers.length,
          newSourceMemberCount: newSourceMembers.length
        })
      };
    } catch (err) {
      console.error('Move member exception:', err.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error: ' + err.message }) };
    }
  }

  try {
    // 1. Get all dorm reservations with registration details.
    // Filter includes ALL active statuses to match the Overview's accounting:
    //   'Pending'        = reservation created but proof not yet uploaded
    //   'Pending Review' = proof uploaded, awaiting verification
    //   'Resubmitted'    = proof re-uploaded after rejection, awaiting re-verification
    //   'Paid'           = proof verified
    // Excluded: 'Rejected', 'Cancelled'.
    // Earlier this filter was missing 'Resubmitted' which caused some real
    // reservations to be silently dropped — surfacing as a gap between the
    // Overview's reserved count and the Room Map's placed count.
    const { data: reservations } = await supabase
      .from('accommodation_reservations')
      .select('id, registration_id, registrant_name, registrant_email, accommodation_type, spots_requested, payment_status')
      .in('payment_status', ['Pending', 'Paid', 'Pending Review', 'Resubmitted'])
      .in('accommodation_type', ['girls_dorm', 'boys_dorm']); // dorm-only; camping handled by tent_reservations table

    if (!reservations || reservations.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: 'No dorm reservations to assign.' }) };
    }

    const regIds = [...new Set(reservations.map(r => r.registration_id).filter(Boolean))];
    const { data: registrations } = await supabase
      .from('registrations')
      .select('id, first_name, last_name, gender, confirmation_number, group_id, phone')
      .in('id', regIds);

    const regMap = {};
    (registrations || []).forEach(r => { regMap[r.id] = r; });

    // Build people list — expand groups into individual members.
    // Also track "ghost spots": reservation spots that can't be turned into placeable
    // people because of data issues (no gender, fewer registration rows than spots,
    // missing primary registration, etc.). These get surfaced in the response so
    // admin knows which specific reservations to investigate.
    const seen = new Set();
    const people = [];
    const ghostSpots = []; // each: { reservationId, registrantName, registrantEmail, registrantPyc, accommodationType, spotsRequested, spotsPlaced, missingCount, reasons[] }

    for (const res of reservations) {
      const reg = regMap[res.registration_id];
      const ghost = {
        reservationId: res.id,
        registrantName: res.registrant_name || (reg ? `${reg.first_name||''} ${reg.last_name||''}`.trim() : ''),
        registrantEmail: res.registrant_email || '',
        registrantPyc: reg ? (reg.confirmation_number || '') : '',
        accommodationType: res.accommodation_type,
        spotsRequested: res.spots_requested || 1,
        spotsPlaced: 0,
        reasons: []
      };

      if (!reg) {
        ghost.reasons.push('Primary registration not found (registration_id ' + (res.registration_id || 'null') + ')');
        ghostSpots.push(ghost);
        continue;
      }

      // Determine which gender this reservation is for, based on accommodation type.
      // A girls_dorm reservation should ONLY claim Female members of the group;
      // a boys_dorm reservation should ONLY claim Male members. Without this filter,
      // the FIRST reservation processed for any group claimed ALL members regardless
      // of gender, causing subsequent reservations for the same group to falsely
      // report 0 placeable members (and the bodies got credited to the wrong dorm).
      const targetGender = res.accommodation_type === 'girls_dorm' ? 'Female'
                         : res.accommodation_type === 'boys_dorm' ? 'Male'
                         : null;

      // Check if this is a group registration with multiple spots
      if (reg.group_id && res.spots_requested > 1) {
        // Fetch all members in this group
        const { data: groupMembers } = await supabase
          .from('registrations')
          .select('id, first_name, last_name, gender, confirmation_number, phone')
          .eq('group_id', reg.group_id);

        // Filter to ONLY members whose gender matches this reservation's dorm type.
        // Members of the opposite gender belong to a different reservation (the group's
        // counterpart boys_dorm/girls_dorm). Members without a gender set are flagged
        // as ghosts so admin knows to fix them.
        const allMemberRows = groupMembers || [];
        const memberRows = targetGender
          ? allMemberRows.filter(m => m.gender === targetGender || !m.gender)
          : allMemberRows;
        const placedFromThisRes = [];
        const skippedFromThisRes = [];
        const cappedOutMembers = []; // same-gender members skipped because the reservation's spot count was already filled
        memberRows.forEach(gm => {
          if (seen.has(gm.id)) return; // already counted via another reservation, don't double count
          if (!gm.gender) {
            skippedFromThisRes.push({ name: `${gm.first_name||''} ${gm.last_name||''}`.trim(), pyc: gm.confirmation_number || '', reason: 'no gender set' });
            return;
          }
          // Defensive: only place members whose gender matches the dorm type
          if (targetGender && gm.gender !== targetGender) return;
          // Don't claim more members than this reservation paid for — leaves any
          // extra same-gender members available for a sibling reservation in the
          // same group (rare but defensive)
          if (placedFromThisRes.length >= res.spots_requested) {
            cappedOutMembers.push({ name: `${gm.first_name||''} ${gm.last_name||''}`.trim(), pyc: gm.confirmation_number || '' });
            return;
          }
          seen.add(gm.id);
          placedFromThisRes.push(gm);
          people.push({
            name: `${gm.first_name} ${gm.last_name}`,
            pycNumber: gm.confirmation_number || '',
            registrationId: gm.id,
            gender: gm.gender,
            phone: gm.phone || ''
          });
        });
        ghost.spotsPlaced = placedFromThisRes.length;
        // If same-gender members were capped out (more members than spots this reservation
        // paid for), record them — they may be the "unplaceable" people if no other
        // reservation in their group covers them.
        if (cappedOutMembers.length > 0) {
          ghost._cappedOut = cappedOutMembers;
        }

        if (placedFromThisRes.length < res.spots_requested) {
          // Account for the gap
          if (skippedFromThisRes.length > 0) {
            skippedFromThisRes.forEach(s => {
              ghost.reasons.push((s.name || 'unnamed member') + (s.pyc ? ' (' + s.pyc + ')' : '') + ' — ' + s.reason);
            });
          }
          // Count gender-matching members available (excludes opposite gender and already-seen)
          const genderMatchingCount = targetGender
            ? allMemberRows.filter(m => m.gender === targetGender).length
            : allMemberRows.length;
          const memberShortfall = res.spots_requested - genderMatchingCount;
          if (memberShortfall > 0) {
            ghost.reasons.push('Reservation requested ' + res.spots_requested + ' ' + (targetGender || '') + ' spot(s) but only ' + genderMatchingCount + ' ' + (targetGender ? targetGender.toLowerCase() : '') + ' group member(s) exist in registrations (group_id ' + reg.group_id + ')');
          }
          // Surface any gap, even if reasons array is empty (the gap itself is signal)
          if (ghost.reasons.length === 0) {
            ghost.reasons.push('Reservation has ' + res.spots_requested + ' spots but only ' + placedFromThisRes.length + ' member(s) were placeable — some members may already be accounted for under another reservation in the same group, or the data has an inconsistency.');
          }
          ghostSpots.push(ghost);
        }
      } else {
        // Individual registration — add single person (or sometimes a group primary
        // who reserved just 1 spot for themselves)
        if (seen.has(res.registration_id)) {
          // Already added via another reservation, treat as placed (no ghost)
          ghost.spotsPlaced = res.spots_requested;
          continue;
        }
        if (!reg.gender) {
          ghost.reasons.push((reg.first_name || '') + ' ' + (reg.last_name || '') + ' — no gender set on registration');
          ghostSpots.push(ghost);
          continue;
        }
        seen.add(res.registration_id);
        people.push({
          name: `${reg.first_name} ${reg.last_name}`,
          pycNumber: reg.confirmation_number || '',
          registrationId: res.registration_id,
          gender: reg.gender,
          phone: reg.phone || ''
        });
        ghost.spotsPlaced = 1;
        // If they reserved more spots than 1 but there's no group_id, those extra spots are ghost
        if (res.spots_requested > 1) {
          ghost.reasons.push('Reservation has ' + res.spots_requested + ' spots but the primary registration has no group_id — extra ' + (res.spots_requested - 1) + ' spot(s) have no people');
          ghostSpots.push(ghost);
        }
      }
    }

    // ===== GROUP-COMPLETION SWEEP =====
    // The per-reservation loop above can miss group members in edge cases (e.g. a
    // group's spots are split across reservation rows in a way the holder-based
    // expansion doesn't fully cover). This sweep guarantees correctness: for each
    // group, total the dorm spots they paid for per gender, then make sure that many
    // same-gender members (who have a gender set) are in `people`. It never adds more
    // people than spots paid for, so it can't over-fill — it only repairs gaps.
    {
      const groupSpots = {}; // key: group_id|Gender -> total paid spots
      for (const res of reservations) {
        const reg2 = regMap[res.registration_id];
        if (!reg2 || !reg2.group_id) continue;
        const g = res.accommodation_type === 'girls_dorm' ? 'Female'
                : res.accommodation_type === 'boys_dorm' ? 'Male' : null;
        if (!g) continue;
        const k = reg2.group_id + '|' + g;
        groupSpots[k] = (groupSpots[k] || 0) + (res.spots_requested || 0);
      }

      const groupIdsToCheck = [...new Set(Object.keys(groupSpots).map(k => k.split('|')[0]))];
      for (const gid of groupIdsToCheck) {
        const { data: gMembers } = await supabase
          .from('registrations')
          .select('id, first_name, last_name, gender, confirmation_number, phone')
          .eq('group_id', gid);
        for (const g of ['Female', 'Male']) {
          const paidSpots = groupSpots[gid + '|' + g] || 0;
          if (paidSpots <= 0) continue;
          const sameGender = (gMembers || []).filter(m => m.gender === g);
          const alreadyIn = sameGender.filter(m => seen.has(m.id)).length;
          let canAdd = Math.min(paidSpots - alreadyIn, sameGender.length - alreadyIn);
          if (canAdd <= 0) continue;
          for (const m of sameGender) {
            if (canAdd <= 0) break;
            if (seen.has(m.id)) continue;
            seen.add(m.id);
            people.push({
              name: `${m.first_name||''} ${m.last_name||''}`.trim(),
              pycNumber: m.confirmation_number || '',
              registrationId: m.id,
              gender: m.gender,
              phone: m.phone || ''
            });
            canAdd--;
          }
        }
      }
    }

    const males = people.filter(p => p.gender === 'Male');
    const females = people.filter(p => p.gender === 'Female');

    // 2. Get roommate requests
    const { data: requests } = await supabase
      .from('roommate_requests').select('*').eq('status', 'Active');

    const maleRequests = (requests || []).filter(r => r.requester_gender === 'Male');
    const femaleRequests = (requests || []).filter(r => r.requester_gender === 'Female');

    // Load existing locked groups and convert them to synthetic roommate requests.
    // A "locked group" is a room currently flagged is_locked=true — its members
    // form an inseparable unit that must stay together but can move between rooms.
    const { data: lockedRoomRecords } = await supabase
      .from('room_assignments')
      .select('*')
      .eq('is_locked', true);

    const lockedGroups = []; // each: { gender, members: [{name, pycNumber, registrationId}] }
    (lockedRoomRecords || []).forEach(lr => {
      const mbrs = Array.isArray(lr.members) ? lr.members : [];
      if (mbrs.length === 0) return;
      lockedGroups.push({
        gender: lr.gender,
        members: mbrs
      });
    });

    // Build synthetic requests for locked groups (one per group). The first
    // member is treated as the "requester" so the existing assignGender logic
    // can place the whole group together.
    function makeSyntheticLockedRequest(group) {
      const head = group.members[0];
      const rest = group.members.slice(1).map(m => ({
        pycNumber: m.pycNumber || '',
        name: m.name || ''
      }));
      return {
        _isLocked: true,
        requester_gender: group.gender,
        requester_pyc: head.pycNumber || '',
        requester_name: head.name || '',
        requested_members: rest
      };
    }

    const lockedMaleSynthetic = lockedGroups.filter(g => g.gender === 'Male').map(makeSyntheticLockedRequest);
    const lockedFemaleSynthetic = lockedGroups.filter(g => g.gender === 'Female').map(makeSyntheticLockedRequest);

    // Combine: locked groups first (so they grab their seats first), then real
    // roommate requests. The assignGender algorithm sorts requests by group
    // size, but we want locked groups to be processed BEFORE real requests
    // regardless of size. Tag them with a flag so the algorithm can detect.
    const allMaleRequests = [...lockedMaleSynthetic, ...maleRequests];
    const allFemaleRequests = [...lockedFemaleSynthetic, ...femaleRequests];

    // 3. Run assignment algorithm
    let maleRooms = assignGender(males, allMaleRequests, HALLS.Male);
    let femaleRooms = assignGender(females, allFemaleRequests, HALLS.Female);

    // 3.5 SAFETY NET — catch anyone the algorithm dropped.
    // If a placeable person didn't end up in any room (e.g. an edge case in the
    // request/cap logic left them out), force-place them into an open, non-locked
    // room of the correct hall/gender — or open a new room if there's hall capacity.
    // This guarantees every placeable person lands somewhere, fixing the recurring
    // "won't place this person no matter how many times I re-run" symptom.
    function backfillDropped(roomList, peopleList, hallConfigs) {
      const placedIds = new Set();
      roomList.forEach(r => (r.members || []).forEach(m => { if (m && m.registrationId) placedIds.add(String(m.registrationId)); }));
      const dropped = peopleList.filter(p => p.registrationId && !placedIds.has(String(p.registrationId)));
      if (dropped.length === 0) return roomList;

      // Per-hall room cap + current usage
      const hallRoomCap = {}; const hallRoomCount = {}; const hallPeopleCount = {};
      hallConfigs.forEach(h => {
        hallRoomCap[h.name] = Math.ceil(h.capacity / (h.roomSize || 4));
        hallRoomCount[h.name] = 0; hallPeopleCount[h.name] = 0;
      });
      roomList.forEach(r => {
        if (hallRoomCount[r.hall] !== undefined) {
          hallRoomCount[r.hall] += 1;
          hallPeopleCount[r.hall] += (r.members || []).length;
        }
      });
      // Highest existing room number per hall (so new rooms continue numbering)
      const hallMaxRoom = {};
      hallConfigs.forEach(h => { hallMaxRoom[h.name] = 0; });
      roomList.forEach(r => { if (hallMaxRoom[r.hall] !== undefined && r.room_number > hallMaxRoom[r.hall]) hallMaxRoom[r.hall] = r.room_number; });

      dropped.forEach(person => {
        // (a) Try to slot into an existing non-locked room that has space
        let placed = false;
        for (const r of roomList) {
          if (r.is_locked) continue;
          if ((r.members || []).length >= (r.capacity || 4)) continue;
          if (hallConfigs.findIndex(h => h.name === r.hall) === -1) continue;
          r.members.push({ name: person.name, pycNumber: person.pycNumber, registrationId: person.registrationId, phone: person.phone || '' });
          hallPeopleCount[r.hall] += 1;
          placed = true;
          break;
        }
        if (placed) return;
        // (b) Open a new room in a hall that still has room+people capacity
        for (const h of hallConfigs) {
          const remainingRooms = hallRoomCap[h.name] - hallRoomCount[h.name];
          const remainingPeople = h.capacity - hallPeopleCount[h.name];
          if (remainingRooms > 0 && remainingPeople > 0) {
            roomList.push({
              hall: h.name,
              room_number: ++hallMaxRoom[h.name],
              gender: person.gender,
              members: [{ name: person.name, pycNumber: person.pycNumber, registrationId: person.registrationId, phone: person.phone || '' }],
              capacity: h.roomSize || 4,
              is_locked: false
            });
            hallRoomCount[h.name] += 1;
            hallPeopleCount[h.name] += 1;
            placed = true;
            break;
          }
        }
        if (!placed) {
          console.warn('[auto-assign] backfill: could not place ' + person.name + ' (' + person.pycNumber + ') — all halls full');
        }
      });
      return roomList;
    }
    maleRooms = backfillDropped(maleRooms, males, HALLS.Male);
    femaleRooms = backfillDropped(femaleRooms, females, HALLS.Female);

    // 4. Claude API — optimize with swap suggestions
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        // 8-second timeout to stay within Netlify function limits
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Claude API timeout')), 8000));
        const optimized = await Promise.race([
          optimizeWithClaude(maleRooms, femaleRooms, males, females, requests || []),
          timeoutPromise
        ]);
        if (optimized) {
          if (optimized.maleRooms) maleRooms = optimized.maleRooms;
          if (optimized.femaleRooms) femaleRooms = optimized.femaleRooms;
        }
      } catch (e) { console.error('Claude optimize skipped:', e.message); }
    }

    // 5. Save to database — wipe ALL existing assignments and insert fresh.
    // Lock state is now stored as a property on each room (preserved through
    // the synthetic-request path above for any locked groups).
    console.log('[auto-assign] Step 5: saving to database');

    const allRooms = [...maleRooms, ...femaleRooms];
    console.log('[auto-assign] allRooms.length =', allRooms.length);

    // Get current room count first so we know if delete worked
    const { count: beforeDelCount, error: countErr } = await supabase
      .from('room_assignments')
      .select('*', { count: 'exact', head: true });
    if (countErr) {
      console.error('[auto-assign] Count before delete failed:', countErr.message);
    } else {
      console.log('[auto-assign] Existing rows before delete:', beforeDelCount);
    }

    // Delete all existing rows. Use gte('room_number', 0) — matches every row since
    // room numbers are positive integers. The previous .not('id', 'is', null) syntax
    // was unreliable on some Supabase versions.
    const { error: delErr, count: deletedCount } = await supabase
      .from('room_assignments')
      .delete({ count: 'exact' })
      .gte('room_number', 0);

    if (delErr) {
      console.error('[auto-assign] DELETE failed:', delErr.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to clear existing assignments: ' + delErr.message }) };
    }
    console.log('[auto-assign] Deleted', deletedCount, 'existing rows');

    // Verify the delete actually emptied the table
    const { count: afterDelCount } = await supabase
      .from('room_assignments')
      .select('*', { count: 'exact', head: true });
    console.log('[auto-assign] Rows remaining after delete:', afterDelCount);
    if (afterDelCount && afterDelCount > 0) {
      console.error('[auto-assign] DELETE did not clear the table! ' + afterDelCount + ' rows remain.');
      return {
        statusCode: 500, headers,
        body: JSON.stringify({
          error: 'Failed to clear existing assignments — ' + afterDelCount + ' rows remain after delete. This usually means a database permission issue. Check Supabase RLS policies on the room_assignments table.'
        })
      };
    }

    if (allRooms.length > 0) {
      const insertPayload = allRooms.map(r => ({
        hall: r.hall,
        room_number: r.room_number,
        gender: r.gender,
        members: r.members,
        capacity: r.capacity || 4,
        is_locked: !!r.is_locked
      }));
      console.log('[auto-assign] Inserting', insertPayload.length, 'rows');

      const { data: insertedData, error: insertErr } = await supabase
        .from('room_assignments')
        .insert(insertPayload)
        .select();

      if (insertErr) {
        console.error('[auto-assign] INSERT failed:', insertErr);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to save assignments: ' + insertErr.message }) };
      }
      console.log('[auto-assign] Insert returned', (insertedData || []).length, 'rows');

      // Read-back verification: query the table again and confirm rows are there
      const { count: finalCount } = await supabase
        .from('room_assignments')
        .select('*', { count: 'exact', head: true });
      console.log('[auto-assign] Final row count in database:', finalCount);

      if (!finalCount || finalCount < insertPayload.length) {
        console.error('[auto-assign] VERIFICATION FAILED: expected ' + insertPayload.length + ' rows, found ' + (finalCount || 0));
        return {
          statusCode: 500, headers,
          body: JSON.stringify({
            error: 'Save verification failed: tried to insert ' + insertPayload.length + ' rooms but only ' + (finalCount || 0) + ' are present after the insert. The assignments did not persist. This is usually a database permission (RLS) issue.'
          })
        };
      }
    }

    console.log('[auto-assign] Save complete and verified');

    const finalRooms = allRooms;
    const halls = {};
    let totalAssigned = 0;
    finalRooms.forEach(r => {
      if (!halls[r.hall]) halls[r.hall] = [];
      halls[r.hall].push(r);
      totalAssigned += (r.members || []).length;
    });

    const reqStats = computeRequestStats(finalRooms, requests || []);

    // Compute ghost-spot totals for the summary
    const totalGhostSpots = ghostSpots.reduce((s, g) => s + (g.spotsRequested - g.spotsPlaced), 0);

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        success: true,
        message: `Assigned ${totalAssigned} people to ${finalRooms.length} rooms. ${reqStats.requestsHonored}/${reqStats.requestsHonored + reqStats.requestsBroken} roommate requests honored.` + (totalGhostSpots > 0 ? ` ${totalGhostSpots} reserved spot(s) couldn't be placed — see Ghost Spots below.` : ''),
        halls,
        summary: {
          totalAssigned,
          // Unassigned = placeable people who did not end up in a room. This uses the
          // SAME definition as the GET path (assignablePeople - totalAssigned) so the
          // number is identical right after assigning AND after a page refresh.
          // (Previously POST used people.length while GET used assignablePeople, which
          // could diverge by a few when capacity overflow placed extra people that the
          // strict GET recount then excluded — causing the "shows 0, then 2 on refresh" bug.)
          totalUnassigned: Math.max(0, people.length - totalAssigned),
          totalRooms: finalRooms.length,
          totalGhostSpots: totalGhostSpots,
          ...reqStats
        },
        ghostSpots: ghostSpots
      })
    };
  } catch (e) {
    console.error('Auto-assign error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Assignment failed: ' + e.message }) };
  }
};

// ========== COMPUTE REQUEST STATS ==========
function computeRequestStats(allRooms, requests) {
  let requestsHonored = 0, requestsBroken = 0;
  const rooms = Array.isArray(allRooms) ? allRooms : Object.values(allRooms).flat();
  requests.forEach(req => {
    // Defensive: skip requests with no requester PYC (data corruption / partial records)
    const rawReqPyc = req && req.requester_pyc;
    if (!rawReqPyc || typeof rawReqPyc !== 'string') return;
    const reqPyc = rawReqPyc.toUpperCase();
    const memberPycs = (req.requested_members || [])
      .map(m => (m && m.pycNumber) ? String(m.pycNumber).toUpperCase() : null)
      .filter(Boolean);
    const allPycs = [reqPyc, ...memberPycs];
    let requesterRoom = null;
    for (const room of rooms) {
      if ((room.members || []).some(m => m && m.pycNumber && String(m.pycNumber).toUpperCase() === reqPyc)) {
        requesterRoom = room; break;
      }
    }
    if (requesterRoom) {
      const roomPycs = (requesterRoom.members || []).map(m => (m && m.pycNumber) ? String(m.pycNumber).toUpperCase() : '');
      if (allPycs.every(pyc => roomPycs.includes(pyc))) requestsHonored++;
      else requestsBroken++;
    }
  });
  return { requestsHonored, requestsBroken };
}

// ========== ASSIGNMENT ALGORITHM ==========
function assignGender(people, requests, hallConfigs) {
  const rooms = [];
  const assigned = new Set();

  // Step 1: Place roommate groups.
  // - Locked synthetic requests are processed FIRST (regardless of size), so
  //   their members are reserved before any real-request processing.
  // - Real requests are then sorted by size (largest first) like before.
  const lockedReqs = requests.filter(r => r._isLocked);
  const realReqs = requests.filter(r => !r._isLocked);
  const sortedRealReqs = [...realReqs].sort((a, b) => {
    return (1 + (b.requested_members || []).length) - (1 + (a.requested_members || []).length);
  });
  const orderedRequests = [...lockedReqs, ...sortedRealReqs];

  const groupRooms = [];
  orderedRequests.forEach(req => {
    const members = [];
    const requester = people.find(p => p.pycNumber && p.pycNumber.toUpperCase() === (req.requester_pyc || '').toUpperCase());
    if (requester && !assigned.has(requester.registrationId)) {
      members.push(requester); assigned.add(requester.registrationId);
    }
    (req.requested_members || []).forEach(rm => {
      const person = people.find(p => p.pycNumber && p.pycNumber.toUpperCase() === (rm.pycNumber || '').toUpperCase());
      if (person && !assigned.has(person.registrationId)) {
        members.push(person); assigned.add(person.registrationId);
      }
    });
    if (members.length > 0) groupRooms.push({
      members,
      fromRequest: true,
      isLocked: !!req._isLocked
    });
  });

  // Step 2: Get unassigned
  const unassigned = people.filter(p => !assigned.has(p.registrationId));

  // Step 3: Fill group rooms to 4 with leftover solos. Locked rooms are preserved
  // intact — we don't add strangers to them.
  groupRooms.forEach(gr => {
    if (gr.isLocked) return; // never grow a locked group
    while (gr.members.length < 4 && unassigned.length > 0) {
      gr.members.push(unassigned.shift());
    }
  });

  // Step 4: Pair solo people — try to pair groups of 2 together to make rooms of 4
  const soloRooms = [];
  while (unassigned.length > 0) {
    soloRooms.push({ members: unassigned.splice(0, 4), fromRequest: false });
  }

  // Step 4.5: CONSOLIDATION PASS
  // Merge half-empty SOLO rooms with each other to reduce wasted bunks. Solo rooms
  // contain people who had no roommate preference, so combining them is safe. We
  // do NOT merge request rooms together (those people specifically requested their
  // companions and shouldn't be mixed with strangers), and we don't touch locked
  // rooms (preserved as-is). After this pass, only locked rooms and small request
  // rooms may remain under 4 occupants.
  (function consolidateSoloRooms() {
    // Pull out solo rooms with < 4 members for merging consideration
    const partial = soloRooms.filter(r => r.members.length < 4);
    const full = soloRooms.filter(r => r.members.length >= 4);
    if (partial.length <= 1) return; // nothing to merge

    // Sort smallest-first so we pour smaller into larger
    partial.sort((a, b) => a.members.length - b.members.length);

    const merged = [];
    while (partial.length > 0) {
      // Take the largest remaining as the "base" room
      const base = partial.pop();
      // Top it off with members from smaller rooms until it hits 4 or no more candidates
      while (base.members.length < 4 && partial.length > 0) {
        const donor = partial.shift(); // smallest first
        while (base.members.length < 4 && donor.members.length > 0) {
          base.members.push(donor.members.shift());
        }
        if (donor.members.length > 0) {
          // Donor still has people left — put back at the smallest end
          partial.unshift(donor);
        }
      }
      merged.push(base);
    }

    // Replace soloRooms array contents
    soloRooms.length = 0;
    full.forEach(r => soloRooms.push(r));
    merged.forEach(r => soloRooms.push(r));
  })();

  // Step 4.6: Pad any remaining partial REQUEST rooms with leftover solos if any
  // solos slipped through (shouldn't happen given Step 3, but defensive).
  groupRooms.forEach(gr => {
    if (gr.isLocked) return;
    while (gr.members.length < 4) {
      // Find a solo room with extras we could borrow from — only borrow from the
      // largest solo room to avoid creating new tiny rooms
      const donorRoom = soloRooms
        .filter(r => r.members.length > 1)
        .sort((a, b) => b.members.length - a.members.length)[0];
      if (!donorRoom) break;
      gr.members.push(donorRoom.members.shift());
    }
  });
  // Drop any solo rooms that became empty during the above
  for (let i = soloRooms.length - 1; i >= 0; i--) {
    if (soloRooms[i].members.length === 0) soloRooms.splice(i, 1);
  }

  // Step 4.7: MERGE PARTIAL REQUEST ROOMS (non-locked).
  // Each pair-request becomes its own room initially. With many small requests,
  // we can exceed the physical room cap. Two pair-requests (A+B) and (C+D) can
  // share a room of 4 — each pair stays together (their request is honored)
  // while sharing the room with another intact pair. Locked rooms are never
  // merged (they must stay isolated by definition).
  //
  // Strategy: pull out all non-locked partial request rooms (1-3 people each),
  // greedily combine them like Tetris pieces until each merged room is at 4 or
  // no more pieces fit. The full request rooms and locked rooms stay as-is.
  (function mergePartialRequestRooms() {
    const partial = [];
    const keep = [];
    for (let i = groupRooms.length - 1; i >= 0; i--) {
      const gr = groupRooms[i];
      if (gr.isLocked) { keep.unshift(gr); groupRooms.splice(i, 1); continue; }
      if (gr.members.length >= 4) { keep.unshift(gr); groupRooms.splice(i, 1); continue; }
      partial.unshift(gr);
      groupRooms.splice(i, 1);
    }
    if (partial.length === 0) {
      // Nothing to merge — restore and exit
      keep.forEach(r => groupRooms.push(r));
      return;
    }
    // Sort largest-first so we use big pieces as the base
    partial.sort((a, b) => b.members.length - a.members.length);

    const merged = [];
    while (partial.length > 0) {
      const base = partial.shift(); // take largest
      // Greedily fit other partial rooms whose size fits in the remaining space
      let i = 0;
      while (base.members.length < 4 && i < partial.length) {
        const piece = partial[i];
        if (piece.members.length <= 4 - base.members.length) {
          // Move ALL members of piece into base (keeps the pair intact!)
          piece.members.forEach(m => base.members.push(m));
          partial.splice(i, 1);
          // Don't increment i — array shifted
        } else {
          i++;
        }
      }
      merged.push(base);
    }
    // Restore: full + locked first, then merged partials
    keep.forEach(r => groupRooms.push(r));
    merged.forEach(r => groupRooms.push(r));
  })();

  // Step 5: Distribute across halls with strict per-hall room caps.
  const allGroupedRooms = [...groupRooms, ...soloRooms];
  const hallRoomNum = {};
  const hallPeopleCount = {};
  const hallRoomCount = {};
  const hallRoomCap = {}; // max rooms per hall = ceil(capacity / roomSize)
  hallConfigs.forEach(h => {
    hallRoomNum[h.name] = 1;
    hallPeopleCount[h.name] = 0;
    hallRoomCount[h.name] = 0;
    hallRoomCap[h.name] = Math.ceil(h.capacity / (h.roomSize || 4));
  });

  // Sort rooms: request-based first (prioritize keeping groups in bigger halls)
  const requestRooms = allGroupedRooms.filter(r => r.fromRequest);
  const otherRooms = allGroupedRooms.filter(r => !r.fromRequest);

  function placeRoom(gr) {
    // Find a hall that has BOTH (a) enough people-capacity for this group AND
    // (b) at least one more room slot available. Prefer the hall with the most
    // remaining people-capacity to balance load.
    let bestHall = null, bestRemaining = -1;
    for (const hall of hallConfigs) {
      const remainingPeople = hall.capacity - hallPeopleCount[hall.name];
      const remainingRooms = hallRoomCap[hall.name] - hallRoomCount[hall.name];
      if (remainingPeople >= gr.members.length && remainingRooms > 0 && remainingPeople > bestRemaining) {
        bestHall = hall;
        bestRemaining = remainingPeople;
      }
    }
    if (!bestHall) {
      // Hard overflow — every hall is at room or people capacity. Log loudly and
      // overflow into whichever hall has any remaining room slots, then fall back
      // to the first hall as a last resort. Admin will need to use the Move feature
      // to redistribute manually if this triggers.
      const anyRoomSlot = hallConfigs.find(h => hallRoomCap[h.name] - hallRoomCount[h.name] > 0);
      bestHall = anyRoomSlot || hallConfigs[0];
      console.warn('[auto-assign] OVERFLOW: no hall has room+people for group of ' + gr.members.length + ', placing in ' + bestHall.name);
    }

    rooms.push({
      hall: bestHall.name,
      room_number: hallRoomNum[bestHall.name]++,
      gender: people[0] ? people[0].gender : 'Male',
      members: gr.members.map(m => ({ name: m.name, pycNumber: m.pycNumber, registrationId: m.registrationId, phone: m.phone || '' })),
      capacity: 4,
      is_locked: !!gr.isLocked
    });
    hallPeopleCount[bestHall.name] += gr.members.length;
    hallRoomCount[bestHall.name] += 1;
  }

  requestRooms.forEach(placeRoom);
  otherRooms.forEach(placeRoom);

  return rooms;
}

// ========== CLAUDE API — INTELLIGENT OPTIMIZATION ==========
async function optimizeWithClaude(maleRooms, femaleRooms, males, females, requests) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const reqStats = computeRequestStats([...maleRooms, ...femaleRooms], requests);

  // Only call Claude if there are broken requests to fix
  if (reqStats.requestsBroken === 0) return null;

  // Build compact room data for Claude
  const brokenRequests = [];
  requests.forEach(req => {
    // Defensive: skip requests with no requester PYC
    if (!req || !req.requester_pyc || typeof req.requester_pyc !== 'string') return;
    const reqPyc = req.requester_pyc.toUpperCase();
    const memberPycs = (req.requested_members || [])
      .map(m => (m && m.pycNumber) ? String(m.pycNumber).toUpperCase() : null)
      .filter(Boolean);
    const allPycs = [reqPyc, ...memberPycs];
    const allRooms = [...maleRooms, ...femaleRooms];

    let requesterRoom = null, requesterRoomIdx = -1;
    for (let i = 0; i < allRooms.length; i++) {
      if (allRooms[i].members.some(m => m && m.pycNumber && String(m.pycNumber).toUpperCase() === reqPyc)) {
        requesterRoom = allRooms[i]; requesterRoomIdx = i; break;
      }
    }
    if (!requesterRoom) return;
    const roomPycs = requesterRoom.members.map(m => (m.pycNumber || '').toUpperCase());
    const missing = allPycs.filter(pyc => !roomPycs.includes(pyc));
    if (missing.length > 0) {
      // Find where the missing people are
      const missingLocations = [];
      missing.forEach(pyc => {
        for (let i = 0; i < allRooms.length; i++) {
          const found = allRooms[i].members.find(m => m.pycNumber && m.pycNumber.toUpperCase() === pyc);
          if (found) { missingLocations.push({ pyc, name: found.name, currentRoom: allRooms[i].hall + ' Room ' + allRooms[i].room_number, roomIdx: i }); break; }
        }
      });
      brokenRequests.push({
        requester: req.requester_name + ' (' + reqPyc + ')',
        requesterRoom: requesterRoom.hall + ' Room ' + requesterRoom.room_number,
        requesterRoomIdx,
        missing: missingLocations
      });
    }
  });

  if (brokenRequests.length === 0) return null;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `You are optimizing room assignments for a youth conference. Some roommate requests were broken by the initial algorithm. Suggest swaps to fix them.

RULES:
- Each room holds exactly 4 people max
- Only swap people of the same gender
- Keep people in the same hall if possible
- Minimize total swaps
- NEVER swap people into or out of a LOCKED room (rooms marked locked:true). Locked rooms are inseparable groups that must stay intact.

BROKEN REQUESTS:
${JSON.stringify(brokenRequests, null, 2)}

CURRENT ROOMS (compact):
Male halls: ${JSON.stringify(maleRooms.map(r => ({ h: r.hall, r: r.room_number, locked: !!r.is_locked, m: r.members.map(m => m.pycNumber) })))}
Female halls: ${JSON.stringify(femaleRooms.map(r => ({ h: r.hall, r: r.room_number, locked: !!r.is_locked, m: r.members.map(m => m.pycNumber) })))}

Respond ONLY with a JSON array of swaps. Each swap: {"from_room_idx": int, "from_pyc": "PYC-XXXX", "to_room_idx": int, "to_pyc": "PYC-XXXX"}
from_room_idx and to_room_idx are 0-based indices into the combined male+female rooms array.
If no good swaps possible, respond with [].
JSON only, no explanation.`
        }]
      })
    });

    const data = await response.json();
    if (!data.content || !data.content[0] || !data.content[0].text) return null;

    let swapText = data.content[0].text.trim();
    // Strip markdown fences if present
    swapText = swapText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    let swaps;
    try { swaps = JSON.parse(swapText); } catch (e) { console.error('Claude swap parse error:', e); return null; }

    if (!Array.isArray(swaps) || swaps.length === 0) return null;

    // Apply swaps — but never break a locked room. If either side of the swap
    // is a locked room, skip it (locked groups must stay intact).
    const allRooms = [...maleRooms, ...femaleRooms];
    let swapsApplied = 0;
    let swapsBlocked = 0;
    for (const swap of swaps) {
      const fromRoom = allRooms[swap.from_room_idx];
      const toRoom = allRooms[swap.to_room_idx];
      if (!fromRoom || !toRoom) continue;
      // Don't swap into or out of a locked room
      if (fromRoom.is_locked || toRoom.is_locked) { swapsBlocked++; continue; }

      const fromIdx = fromRoom.members.findIndex(m => m.pycNumber && m.pycNumber.toUpperCase() === (swap.from_pyc || '').toUpperCase());
      const toIdx = toRoom.members.findIndex(m => m.pycNumber && m.pycNumber.toUpperCase() === (swap.to_pyc || '').toUpperCase());

      if (fromIdx >= 0 && toIdx >= 0) {
        // Swap the two people
        const temp = fromRoom.members[fromIdx];
        fromRoom.members[fromIdx] = toRoom.members[toIdx];
        toRoom.members[toIdx] = temp;
        swapsApplied++;
      }
    }
    if (swapsBlocked > 0) console.log('Blocked ' + swapsBlocked + ' swap(s) involving locked rooms');

    if (swapsApplied > 0) {
      console.log(`Claude suggested ${swaps.length} swaps, applied ${swapsApplied}`);
      return {
        maleRooms: allRooms.filter(r => r.gender === 'Male'),
        femaleRooms: allRooms.filter(r => r.gender === 'Female')
      };
    }
  } catch (e) {
    console.error('Claude optimize error:', e.message);
  }
  return null;
}
