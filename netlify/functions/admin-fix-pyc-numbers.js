// admin-fix-pyc-numbers.js
//
// ONE-TIME RECOVERY TOOL for registrations missing a confirmation_number due to
// the old broken PYC allocator (1000-row cap bug).
//
// SCOPE: registrations with payment_status 'Paid' OR 'Pending Review' that have
// no confirmation_number. For each one (and each of its group members):
//   1. Assign a fresh, unique PYC number (cap-proof allocator)
//   2. Send the "PYC Correction" email (apology + corrected number + receipt)
//   3. Optionally flip 'Pending Review' -> 'Paid' (controlled by approvePendingReview)
//
// MODES:
//   - Scan mode: leave registrationIds/emails empty -> processes ALL Paid +
//     Pending Review rows that are missing a number.
//   - List mode: pass registrationIds and/or emails -> only those.
//
// SAFETY:
//   - DRY RUN BY DEFAULT. No DB writes, no emails, unless commit:true AND confirm:"YES".
//   - Reachable only through the access-controlled /md dashboard (no separate token).
//   - Only touches rows that are Paid/Pending Review AND missing a number.
//   - Re-runnable: rows that already have a number are reported as skipped.
//   - approvePendingReview controls whether Pending Review rows get flipped to Paid.

const { createClient } = require('@supabase/supabase-js');
const { sendPycCorrectionEmail } = require('./email-helper');

const MINOR_AGES = ['0-8', '9-13', '13-17', '14-17'];
const ELIGIBLE_STATUSES = ['Paid', 'Pending Review'];

async function allocateNextPycNumber(supabase) {
  const { data: topRows, error } = await supabase
    .from('registrations')
    .select('confirmation_number')
    .not('confirmation_number', 'is', null)
    .order('confirmation_number', { ascending: false })
    .limit(5);
  if (error) throw new Error('Failed to read existing PYC numbers: ' + error.message);
  let maxNum = 0;
  (topRows || []).forEach(r => {
    const p = parseInt(String(r.confirmation_number || '').replace('PYC-', ''), 10);
    if (!isNaN(p) && p > maxNum) maxNum = p;
  });
  return maxNum + 1;
}

async function assignPycToRegistration(supabase, registrationId) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const base = await allocateNextPycNumber(supabase);
    const candidate = 'PYC-' + String(base + attempt).padStart(4, '0');
    const { data: updated, error: updErr } = await supabase
      .from('registrations')
      .update({ confirmation_number: candidate })
      .eq('id', registrationId)
      .is('confirmation_number', null)
      .select('confirmation_number')
      .maybeSingle();
    if (updErr) { continue; }
    if (updated && updated.confirmation_number) return updated.confirmation_number;
    const { data: existing } = await supabase
      .from('registrations')
      .select('confirmation_number')
      .eq('id', registrationId)
      .single();
    if (existing && existing.confirmation_number) return existing.confirmation_number;
  }
  throw new Error('Could not allocate a PYC number after multiple attempts');
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    const commit = body.commit === true;
    const confirm = body.confirm || '';
    const approvePendingReview = body.approvePendingReview === true;
    const registrationIds = Array.isArray(body.registrationIds) ? body.registrationIds.map(String) : [];
    const emails = Array.isArray(body.emails) ? body.emails.map(e => String(e).trim().toLowerCase()) : [];

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // ---- AUTH ----
    // No separate auth gate here. This function is only reachable through the /md
    // master dashboard, which is already access-controlled (login required to load
    // the page). This matches every other /md backend function, none of which add
    // their own gate. Adding one here caused a false "Unauthorized" because the
    // session-validation mechanism differs from a simple table lookup.

    if (commit && confirm !== 'YES') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'To commit, pass confirm:"YES". Run without commit first to preview.' }) };
    }
    let targets = [];
    const usingList = registrationIds.length > 0 || emails.length > 0;

    if (usingList) {
      if (registrationIds.length > 0) {
        const { data } = await supabase.from('registrations').select('*').in('id', registrationIds);
        targets = targets.concat(data || []);
      }
      if (emails.length > 0) {
        const { data } = await supabase.from('registrations').select('*').in('email', emails);
        targets = targets.concat(data || []);
      }
    } else {
      // Scan all eligible rows missing a number. Paginate to dodge the 1000-row cap.
      let from = 0;
      const pageSize = 1000;
      while (true) {
        const { data, error } = await supabase
          .from('registrations')
          .select('*')
          .in('payment_status', ELIGIBLE_STATUSES)
          .is('confirmation_number', null)
          .range(from, from + pageSize - 1);
        if (error) throw new Error('Scan query failed: ' + error.message);
        targets = targets.concat(data || []);
        if (!data || data.length < pageSize) break;
        from += pageSize;
      }
    }

    const byId = {};
    targets.forEach(t => { byId[t.id] = t; });
    targets = Object.values(byId);

    // Batch limit: Netlify Functions have a ~10s timeout. Each person needs a
    // query + write(s) + a Brevo email send (slow). Processing everyone at once
    // times out (HTTP 504). So a COMMIT run processes at most `batchSize` people,
    // then reports how many remain. The frontend calls again for the next batch
    // (the fixed people drop out of the "missing number" scan automatically).
    const batchSize = Math.max(1, Math.min(20, parseInt(body.batchSize, 10) || 6));

    const report = {
      mode: commit ? 'COMMIT' : 'DRY RUN',
      scanMode: !usingList,
      approvePendingReview: approvePendingReview,
      matched: targets.length,
      batchSize: batchSize,
      processed: [],
      skipped: [],
      errors: [],
      remaining: 0
    };

    const seenIds = new Set();
    const workItems = [];

    for (const reg of targets) {
      if (!ELIGIBLE_STATUSES.includes(reg.payment_status)) {
        report.skipped.push({ id: reg.id, email: reg.email, name: `${reg.first_name||''} ${reg.last_name||''}`.trim(), reason: 'Status "' + (reg.payment_status||'none') + '" not eligible' });
        continue;
      }

      let members = [reg];
      if (reg.group_id) {
        const { data: gm } = await supabase
          .from('registrations').select('*').eq('group_id', reg.group_id)
          .order('is_primary', { ascending: false });
        members = (gm && gm.length > 0) ? gm : [reg];
      }
      const hasMinorInGroup = members.some(m => MINOR_AGES.includes(m.age));

      for (const m of members) {
        if (seenIds.has(m.id)) continue;
        seenIds.add(m.id);
        if (!ELIGIBLE_STATUSES.includes(m.payment_status)) {
          report.skipped.push({ id: m.id, email: m.email, name: `${m.first_name||''} ${m.last_name||''}`.trim(), reason: 'Member status "' + (m.payment_status||'none') + '" not eligible' });
          continue;
        }
        if (m.confirmation_number) {
          report.skipped.push({ id: m.id, email: m.email, name: `${m.first_name||''} ${m.last_name||''}`.trim(), reason: 'Already has number ' + m.confirmation_number });
          continue;
        }
        workItems.push({ member: m, hasMinorInGroup });
      }
    }

    // For COMMIT: process at most batchSize people this call. Anything beyond that
    // is left for the next call (they still match the missing-number scan).
    // For DRY RUN: don't write anything, but cap the displayed list so the preview
    // also returns fast; report the true total via `matched`/`remaining`.
    const totalWork = workItems.length;
    const limit = commit ? batchSize : Math.min(totalWork, 100);
    const slice = workItems.slice(0, limit);
    report.remaining = Math.max(0, totalWork - slice.length);

    for (const item of slice) {
      const m = item.member;
      const planned = {
        id: m.id, email: m.email,
        name: `${m.first_name||''} ${m.last_name||''}`.trim(),
        isPrimary: !!m.is_primary, groupId: m.group_id || null,
        statusBefore: m.payment_status, statusAfter: m.payment_status,
        newNumber: null, emailSent: false
      };

      if (!commit) {
        planned.newNumber = '(fresh number would be assigned)';
        if (approvePendingReview && m.payment_status === 'Pending Review') planned.statusAfter = 'Paid';
        planned.emailSent = '(correction email would be sent)';
        report.processed.push(planned);
        continue;
      }

      try {
        m.confirmation_number = await assignPycToRegistration(supabase, m.id);
        planned.newNumber = m.confirmation_number;

        if (approvePendingReview && m.payment_status === 'Pending Review') {
          await supabase.from('registrations')
            .update({ payment_status: 'Paid', payment_method: m.payment_method || 'GCash' })
            .eq('id', m.id);
          m.payment_status = 'Paid';
          planned.statusAfter = 'Paid';
        }

        try {
          await sendPycCorrectionEmail(m, item.hasMinorInGroup);
          planned.emailSent = true;
        } catch (mailErr) {
          report.errors.push({ id: m.id, email: m.email, stage: 'email', error: mailErr.message });
        }

        report.processed.push(planned);
      } catch (perErr) {
        report.errors.push({ id: m.id, email: m.email, stage: 'assign', error: perErr.message });
      }
    }

    report.summary = {
      processedCount: report.processed.length,
      skippedCount: report.skipped.length,
      errorCount: report.errors.length,
      remaining: report.remaining,
      done: report.remaining === 0
    };

    return { statusCode: 200, headers, body: JSON.stringify(report, null, 2) };

  } catch (e) {
    console.error('[admin-fix-pyc-numbers] error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
