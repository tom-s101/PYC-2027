const { createClient } = require('@supabase/supabase-js');
const { sendApprovalReceiptEmail, sendRejectionEmail } = require('./email-helper');

// ============================================================================
// PYC NUMBER ALLOCATION — cap-proof + collision-safe
//
// The OLD approach was:
//   select('confirmation_number').not('confirmation_number','is',null)
//   then loop in JS to find the max.
// This is broken for two reasons:
//   1. PostgREST caps results at 1000 rows by default. Once 1000+ numbers were
//      assigned, the query never saw the true maximum, so it kept computing the
//      same "next" number (e.g. always PYC-1183) — the stuck-number symptom.
//      Some people then got NO number at all (the unique write collided/failed,
//      and because the email send sits in the same try block, no email fired).
//   2. Two simultaneous approvals would both read the same max and assign the
//      same number (or one would silently fail).
//
// The new approach asks Postgres directly for the single highest number
// (order desc, limit) which is NOT subject to the 1000-row cap, then does a
// small retry loop to absorb any race between concurrent approvals.
// ============================================================================
async function allocateNextPycNumber(supabase) {
  // Pull the highest existing confirmation_number directly from Postgres.
  // All numbers are zero-padded to 4 digits (PYC-0001 .. PYC-9999) so lexical
  // order == numeric order. We still parse defensively in case of malformed values.
  const { data: topRows, error } = await supabase
    .from('registrations')
    .select('confirmation_number')
    .not('confirmation_number', 'is', null)
    .order('confirmation_number', { ascending: false })
    .limit(5);

  if (error) {
    console.error('[allocateNextPycNumber] query error:', error.message);
    throw new Error('Failed to read existing PYC numbers: ' + error.message);
  }

  let maxNum = 0;
  (topRows || []).forEach(r => {
    const p = parseInt(String(r.confirmation_number || '').replace('PYC-', ''), 10);
    if (!isNaN(p) && p > maxNum) maxNum = p;
  });
  return maxNum + 1;
}

// Claims the next available PYC number for one registration row, only if it
// doesn't already have one. Retries on collision (concurrent approval grabbed
// the same integer). Returns the assigned/existing number string.
async function assignPycToRegistration(supabase, registrationId) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const base = await allocateNextPycNumber(supabase);
    const candidate = 'PYC-' + String(base + attempt).padStart(4, '0');
    // Conditional write: only set if still null. This prevents clobbering a
    // number assigned by a concurrent request.
    const { data: updated, error: updErr } = await supabase
      .from('registrations')
      .update({ confirmation_number: candidate })
      .eq('id', registrationId)
      .is('confirmation_number', null)
      .select('confirmation_number')
      .maybeSingle();

    if (updErr) {
      // Likely a unique-constraint collision — try the next number
      console.warn('[assignPycToRegistration] attempt', attempt, 'collision/err:', updErr.message);
      continue;
    }
    if (updated && updated.confirmation_number) {
      return updated.confirmation_number;
    }
    // updated is null → row already had a number (set by us earlier or a
    // concurrent request). Re-read and return it.
    const { data: existing } = await supabase
      .from('registrations')
      .select('confirmation_number')
      .eq('id', registrationId)
      .single();
    if (existing && existing.confirmation_number) return existing.confirmation_number;
  }
  throw new Error('Could not allocate a PYC number after multiple attempts');
}

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { registrationId, approve } = JSON.parse(event.body);
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Fetch the registration
    const { data: record, error: fetchError } = await supabase
      .from('registrations')
      .select('*')
      .eq('id', registrationId)
      .single();

    if (fetchError || !record) {
      throw new Error('Registration not found');
    }

    const newStatus = approve ? 'Paid' : 'Rejected';

    // If group, update all members
    if (record.group_id) {
      const { error: updateError } = await supabase
        .from('registrations')
        .update({ payment_status: newStatus, payment_method: 'GCash' })
        .eq('group_id', record.group_id);

      if (updateError) throw new Error('Failed to update: ' + updateError.message);
    } else {
      const { error: updateError } = await supabase
        .from('registrations')
        .update({ payment_status: newStatus, payment_method: 'GCash' })
        .eq('id', registrationId);

      if (updateError) throw new Error('Failed to update: ' + updateError.message);
    }

    // Send receipt email on approval
    if (approve) {
      try {
        // Re-fetch to get confirmation_number
        const { data: updatedRecord } = await supabase
          .from('registrations')
          .select('*')
          .eq('id', registrationId)
          .single();

        // Auto-generate confirmation_number if missing (cap-proof allocator)
        if (updatedRecord && !updatedRecord.confirmation_number) {
          try {
            updatedRecord.confirmation_number = await assignPycToRegistration(supabase, updatedRecord.id);
          } catch (e) { console.error('Conf num gen error:', e.message); }
        }

        if (updatedRecord) {
          // Check if any member in this group (or the individual) is a minor
          const minorAges = ['0-8', '9-13', '13-17', '14-17'];
          let hasMinorInGroup = minorAges.includes(updatedRecord.age);
          let allGroupMembers = [];

          if (updatedRecord.group_id) {
            // Fetch ALL group members including primary
            const { data: allMembers } = await supabase
              .from('registrations')
              .select('*')
              .eq('group_id', updatedRecord.group_id)
              .order('is_primary', { ascending: false });
            allGroupMembers = allMembers || [];
            if (!hasMinorInGroup) {
              hasMinorInGroup = allGroupMembers.some(m => minorAges.includes(m.age));
            }

            // Fix confirmation numbers: detect missing OR duplicate-within-group,
            // then allocate a fresh cap-proof number for each one that needs it.
            const groupNums = new Set();
            const needsNewNum = [];
            for (const m of allGroupMembers) {
              if (!m.confirmation_number || groupNums.has(m.confirmation_number)) {
                needsNewNum.push(m);
              } else {
                groupNums.add(m.confirmation_number);
              }
            }

            if (needsNewNum.length > 0) {
              console.log('Fixing', needsNewNum.length, 'members with missing/duplicate conf numbers');
              for (const m of needsNewNum) {
                try {
                  // If this member already has a (duplicate) number, clear it first
                  // so the conditional allocator can assign a clean one.
                  if (m.confirmation_number) {
                    await supabase.from('registrations')
                      .update({ confirmation_number: null })
                      .eq('id', m.id);
                  }
                  const newConf = await assignPycToRegistration(supabase, m.id);
                  m.confirmation_number = newConf;
                  console.log('Fixed conf number for', m.first_name, m.last_name, '->', newConf);
                } catch (e) {
                  console.error('Conf fix error for', m.first_name, m.last_name, ':', e.message);
                }
              }

              // Re-read updatedRecord's number if the primary was one of the fixed ones
              const fixedPrimary = allGroupMembers.find(m => m.id === registrationId);
              if (fixedPrimary) updatedRecord.confirmation_number = fixedPrimary.confirmation_number;
            }
          }

          // Send email to primary
          await sendApprovalReceiptEmail(updatedRecord, hasMinorInGroup);
          console.log('Primary approval email sent:', updatedRecord.first_name, updatedRecord.last_name, 'conf:', updatedRecord.confirmation_number);

          // Send email to each non-primary group member
          if (updatedRecord.group_id && allGroupMembers.length > 0) {
            const nonPrimary = allGroupMembers.filter(m => m.id !== registrationId);
            console.log('Sending approval emails to', nonPrimary.length, 'group members');

            for (const member of nonPrimary) {
              try {
                await sendApprovalReceiptEmail(member, hasMinorInGroup);
                console.log('Member email sent:', member.first_name, member.last_name, 'conf:', member.confirmation_number);
              } catch(e) { console.error('Member email error for', member.first_name, member.last_name, ':', e.message); }
            }
          }
        }
      } catch (emailError) {
        console.error('Approval email error:', emailError);
      }
    }

    // Send rejection email
    if (!approve) {
      try {
        const { data: rejectedRecord } = await supabase
          .from('registrations')
          .select('*')
          .eq('id', registrationId)
          .single();
        if (rejectedRecord) {
          if (!rejectedRecord.confirmation_number) {
            try {
              rejectedRecord.confirmation_number = await assignPycToRegistration(supabase, rejectedRecord.id);
            } catch (e) { console.error('Conf num gen error (reject):', e.message); }
          }
          await sendRejectionEmail(rejectedRecord);
        }
      } catch (emailError) {
        console.error('Rejection email error:', emailError);
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: approve ? 'Payment approved!' : 'Payment rejected'
      })
    };

  } catch (error) {
    console.error('Approve payment error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};
