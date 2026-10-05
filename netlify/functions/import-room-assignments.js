const { createClient } = require('@supabase/supabase-js');

// import-room-assignments.js
// Accepts parsed rows from the PYC2026_RoomAssignments Google Sheet and writes
// them into the room_assignments table. Rows come from client-side SheetJS parsing.
//
// Sheet structure (0-indexed columns after skipping title+header rows):
//   Col 0 (A): Dormitory / Hall name  e.g. "Onyx", "Pearl"
//   Col 1 (B): Room #                 e.g. 118, 112 (a number)
//   Col 2 (C): Counting# (group num)  ignored
//   Col 3 (D): Name
//   Col 4 (E): PYC Number             e.g. "PYC-0187"
//   Col 5 (F): Room Contact (phone)
//   Col 6 (G): Locked                 "Yes" / "No"
//   Col 7+ :   WALK IN REG, Volunteers, Arrival Date, Note — ignored
//
// The function:
//   1. Looks up every PYC in the registrations table to get registrationId + gender
//   2. Builds a map of hall+roomNum -> {members, is_locked, contact}
//   3. Upserts into room_assignments — adds new rooms, updates existing unlocked ones
//      (locked rooms in the DB are left completely untouched)
//   4. Returns a detailed result: matched, unmatched PYCs, rooms written

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    // rows: array of arrays — each inner array is one spreadsheet row, already
    // trimmed to the relevant columns [hall, roomNum, countingNum, name, pyc, contact, locked, ...]
    const { rows, dryRun } = body;

    if (!Array.isArray(rows) || rows.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No rows provided' }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // ---- Step 1: Collect all unique PYC numbers from the sheet ----
    const allPycs = new Set();
    rows.forEach(function(r) {
      const pyc = (r[4] || '').toString().trim().toUpperCase();
      if (pyc && pyc.startsWith('PYC-')) allPycs.add(pyc);
    });

    if (allPycs.size === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No valid PYC numbers found. Make sure column E contains values like PYC-0187.' }) };
    }

    // ---- Step 2: Look up registrationId + gender + name for every PYC ----
    // Batch in groups of 500 to avoid URL length limits.
    const pycList = Array.from(allPycs);
    const regByPyc = {}; // PYC -> { id, gender, first_name, last_name, phone }
    const batchSize = 500;
    for (let i = 0; i < pycList.length; i += batchSize) {
      const batch = pycList.slice(i, i + batchSize);
      const { data, error } = await supabase
        .from('registrations')
        .select('id, confirmation_number, gender, first_name, last_name, phone')
        .in('confirmation_number', batch);
      if (error) throw new Error('Failed to look up registrations: ' + error.message);
      (data || []).forEach(function(reg) {
        if (reg.confirmation_number) {
          regByPyc[reg.confirmation_number.toUpperCase()] = reg;
        }
      });
    }

    // ---- Step 3: Build room map from the sheet rows ----
    // Key: "Hall|RoomNumber" -> { hall, room_number, gender, is_locked, members[], contact }
    const roomMap = {};
    const unmatched = []; // PYCs not found in registrations
    const matched = [];

    rows.forEach(function(r) {
      const hall     = (r[0] || '').toString().trim();
      const roomNum  = parseInt((r[1] || '').toString().trim(), 10);
      const name     = (r[3] || '').toString().trim();
      const pyc      = (r[4] || '').toString().trim().toUpperCase();
      const contact  = (r[5] || '').toString().trim();
      const lockedStr = (r[6] || '').toString().trim().toLowerCase();
      const isLocked = lockedStr === 'yes' || lockedStr === 'true' || lockedStr === '1';

      if (!hall || isNaN(roomNum) || !pyc || !pyc.startsWith('PYC-')) return;

      const key = hall + '|' + roomNum;
      if (!roomMap[key]) {
        roomMap[key] = {
          hall: hall,
          room_number: roomNum,
          gender: null,       // determined from first member with known gender
          is_locked: isLocked,
          contact: contact,
          members: []
        };
      }

      // Look up the person in registrations
      const reg = regByPyc[pyc];
      if (!reg) {
        unmatched.push({ pyc, name, hall, roomNum });
        // Still add to room as a "placeholder" member — name from sheet, no registrationId
        roomMap[key].members.push({
          name: name,
          pycNumber: pyc,
          registrationId: null,
          phone: contact,
          gender: null
        });
        return;
      }

      const memberName = name || ((reg.first_name || '') + ' ' + (reg.last_name || '')).trim();
      const member = {
        name: memberName,
        pycNumber: pyc,
        registrationId: reg.id,
        phone: contact || reg.phone || '',
        gender: reg.gender || null
      };
      roomMap[key].members.push(member);

      // Set room gender from first member with a known gender
      if (!roomMap[key].gender && reg.gender) {
        roomMap[key].gender = reg.gender;
      }

      matched.push({ pyc, name: memberName, hall, roomNum });
    });

    const roomsToWrite = Object.values(roomMap);

    if (dryRun) {
      // Preview mode — don't write to the database
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          success: true,
          dryRun: true,
          summary: {
            totalRows: rows.length,
            totalRooms: roomsToWrite.length,
            matched: matched.length,
            unmatched: unmatched.length,
          },
          unmatched,
          sampleRooms: roomsToWrite.slice(0, 5).map(function(rm) {
            return { hall: rm.hall, room_number: rm.room_number, memberCount: rm.members.length, members: rm.members.map(function(m){ return m.name + ' (' + m.pycNumber + ')'; }) };
          })
        })
      };
    }

    // ---- Step 4: Read existing room_assignments to respect locked rooms ----
    const { data: existingRooms, error: fetchErr } = await supabase
      .from('room_assignments')
      .select('*');
    if (fetchErr) throw new Error('Failed to read existing assignments: ' + fetchErr.message);

    const existingByKey = {};
    (existingRooms || []).forEach(function(rm) {
      existingByKey[rm.hall + '|' + rm.room_number] = rm;
    });

    // ---- Step 5: Upsert rooms ----
    // For each room in the sheet:
    //   - If it exists in DB and is_locked=true → SKIP (don't overwrite locked rooms)
    //   - If it exists in DB and not locked → UPDATE members + is_locked
    //   - If it doesn't exist → INSERT
    const toInsert = [];
    const toUpdate = [];
    const skippedLocked = [];

    roomsToWrite.forEach(function(rm) {
      const key = rm.hall + '|' + rm.room_number;
      const existing = existingByKey[key];
      const payload = {
        hall: rm.hall,
        room_number: rm.room_number,
        gender: rm.gender,
        members: rm.members,
        capacity: rm.members.length > 0 ? Math.max(rm.members.length, 4) : 4,
        is_locked: rm.is_locked
      };

      if (existing) {
        if (existing.is_locked) {
          skippedLocked.push(key);
          return; // Leave locked rooms alone
        }
        toUpdate.push({ id: existing.id, ...payload });
      } else {
        toInsert.push(payload);
      }
    });

    // Insert new rooms
    let insertedCount = 0;
    if (toInsert.length > 0) {
      const { error: insertErr } = await supabase
        .from('room_assignments')
        .insert(toInsert);
      if (insertErr) throw new Error('Insert failed: ' + insertErr.message);
      insertedCount = toInsert.length;
    }

    // Update existing rooms
    let updatedCount = 0;
    for (const rm of toUpdate) {
      const { id, ...payload } = rm;
      const { error: updateErr } = await supabase
        .from('room_assignments')
        .update(payload)
        .eq('id', id);
      if (updateErr) {
        console.error('Update failed for room', rm.hall, rm.room_number, updateErr.message);
      } else {
        updatedCount++;
      }
    }

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        success: true,
        dryRun: false,
        summary: {
          totalRows: rows.length,
          totalRooms: roomsToWrite.length,
          matched: matched.length,
          unmatched: unmatched.length,
          inserted: insertedCount,
          updated: updatedCount,
          skippedLocked: skippedLocked.length
        },
        unmatched,
        skippedLocked
      })
    };

  } catch (err) {
    console.error('import-room-assignments error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
