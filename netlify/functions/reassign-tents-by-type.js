const { createClient } = require('@supabase/supabase-js');

// Reassign ALL active tent reservations to cluster by tent_group_type.
// Strategy: each group type (married, family, friends, unknown) gets a contiguous
// range of canopies. Tents with group_type=null (existing reservations that haven't
// been backfilled) go last so they don't interfere.
//
// Called from ar.html "Reassign Tents by Group Type" button.

const TOTAL_CANOPIES = 10;
const TENTS_PER_CANOPY = 40;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Load all active tents with proof uploaded (stale Pending are not real reservations)
    const { data: tents, error: loadErr } = await supabase
      .from('tent_reservations')
      .select('id, canopy_number, tent_group_type, created_at, registrant_name')
      .eq('status', 'Active')
      .in('payment_status', ['Pending Review', 'Resubmitted', 'Paid'])
      .order('created_at', { ascending: true });

    if (loadErr) {
      console.error('Load error:', loadErr.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to load tents' }) };
    }

    const allTents = tents || [];
    if (allTents.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'No active tent reservations to reassign.', summary: {} }) };
    }

    // Bucket by type. 'unknown' goes to a separate bucket so old reservations
    // without a type stay together in the earliest canopies (they were reserved first).
    const buckets = { married: [], family: [], friends: [], unknown: [] };
    for (const t of allTents) {
      const gt = t.tent_group_type;
      if (gt === 'married' || gt === 'family' || gt === 'friends') buckets[gt].push(t);
      else buckets.unknown.push(t);
    }

    // Assignment order: unknown first (they reserved earliest so keep in early canopies),
    // then married, family, friends. This means the older reservations stay put
    // in canopies 1-N, and the new group-type tents cluster afterward.
    const processOrder = ['unknown', 'married', 'family', 'friends'];

    // Build new canopy assignments. Fill each canopy up to TENTS_PER_CANOPY before
    // moving to the next. A type's tents will naturally cluster.
    const assignments = []; // [{id, newCanopy}]
    let currentCanopy = 1;
    let currentCanopyCount = 0;

    for (const typeKey of processOrder) {
      const bucket = buckets[typeKey];
      for (const tent of bucket) {
        if (currentCanopy > TOTAL_CANOPIES) {
          return { statusCode: 409, headers, body: JSON.stringify({ error: 'Too many active tents — exceeds capacity.' }) };
        }
        // If current canopy is full, move to next
        if (currentCanopyCount >= TENTS_PER_CANOPY) {
          currentCanopy += 1;
          currentCanopyCount = 0;
          if (currentCanopy > TOTAL_CANOPIES) {
            return { statusCode: 409, headers, body: JSON.stringify({ error: 'Too many active tents — exceeds capacity.' }) };
          }
        }
        assignments.push({ id: tent.id, newCanopy: currentCanopy, type: typeKey });
        currentCanopyCount += 1;
      }
      // After finishing a type, move to the next canopy so the NEXT type starts fresh.
      // Only if we placed any tents of this type in the current canopy AND there are
      // more types still to process. This gives each type its own starting canopy.
      if (bucket.length > 0 && currentCanopyCount > 0) {
        currentCanopy += 1;
        currentCanopyCount = 0;
      }
    }

    // Apply the new canopy numbers
    let updatedCount = 0;
    for (const a of assignments) {
      const { error: updErr } = await supabase
        .from('tent_reservations')
        .update({ canopy_number: a.newCanopy, updated_at: new Date().toISOString() })
        .eq('id', a.id);
      if (updErr) {
        console.error('Update error for id', a.id, ':', updErr.message);
        // continue — don't fail the whole batch
      } else {
        updatedCount += 1;
      }
    }

    // Build summary: how many tents of each type per canopy
    const summary = {};
    for (const a of assignments) {
      if (!summary[a.newCanopy]) summary[a.newCanopy] = {};
      summary[a.newCanopy][a.type] = (summary[a.newCanopy][a.type] || 0) + 1;
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: 'Reassigned ' + updatedCount + ' of ' + allTents.length + ' tents by group type.',
        updatedCount: updatedCount,
        totalTents: allTents.length,
        summary: summary
      })
    };
  } catch (err) {
    console.error('reassign-tents-by-type error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
