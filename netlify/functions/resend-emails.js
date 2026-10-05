const { createClient } = require('@supabase/supabase-js');
const { sendConfirmationEmail, sendApprovalReceiptEmail } = require('./email-helper');
const { sendPendingEmail, sendApprovedEmail } = require('./accommodation-email-helper');

// Admin one-shot tool: re-send emails that failed during the Brevo IP-block outage.
//
// Input (POST JSON):
//   {
//     emailType: 'conference_confirmation' | 'conference_approval' | 'accommodation_pending' | 'accommodation_approved',
//     dryRun: boolean,
//     windowStart?: ISO string,    // OPTIONAL — if omitted/blank, NO time filter is applied
//     offset?: number,
//     limit?: number
//   }
//
// We filter by created_at (not updated_at) because updated_at isn't reliably
// bumped by all code paths in this codebase. Sending duplicates is acceptable
// per the admin's explicit decision.
//
// Output: { success, total, totalNoWindow, sent, failed, items: [...] }

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

    const emailType = String(parsed.emailType || '').trim();
    const dryRun = parsed.dryRun !== false;
    const rawWindow = parsed.windowStart;
    const windowStart = (typeof rawWindow === 'string' && rawWindow.trim().length > 0) ? rawWindow.trim() : null;
    const offset = Math.max(0, parseInt(parsed.offset) || 0);
    const limit = Math.min(1000, Math.max(1, parseInt(parsed.limit) || 50));
    // Optional: target specific records by id, pyc, or email (used by Retry Failed + Manual Send)
    const targetIds = Array.isArray(parsed.ids) ? parsed.ids.filter(function(x) { return typeof x === 'string' && x.length > 0; }) : null;
    const targetPycs = Array.isArray(parsed.pycs) ? parsed.pycs.map(function(x) { return String(x).trim().toUpperCase(); }).filter(Boolean) : null;
    const targetEmails = Array.isArray(parsed.emails) ? parsed.emails.map(function(x) { return String(x).trim().toLowerCase(); }).filter(Boolean) : null;

    const VALID_TYPES = ['conference_confirmation', 'conference_approval', 'accommodation_pending', 'accommodation_approved'];
    if (VALID_TYPES.indexOf(emailType) === -1) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid emailType. Must be one of: ' + VALID_TYPES.join(', ') }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    let candidates = [];
    let totalCount = 0;
    let totalNoWindow = 0; // diagnostic: total matching status filters without time filter
    let notFoundIdentifiers = []; // for manual mode: identifiers that didn't resolve to a record

    // ===== TARGETED MODE: fetch only specified records, no status/window filtering =====
    const hasTargets = (targetIds && targetIds.length) || (targetPycs && targetPycs.length) || (targetEmails && targetEmails.length);
    if (hasTargets) {
      const isConference = emailType.indexOf('conference') === 0;
      const tableName = isConference ? 'registrations' : 'accommodation_reservations';
      const selectCols = isConference
        ? 'id, first_name, last_name, email, confirmation_number, payment_status, total_amount, meal_plan, group_id, is_primary, registration_type, created_at, age'
        : '*';

      // Resolve PYC numbers and emails -> IDs (for accommodations, emails map directly via registrant_email)
      const collectedIds = new Set();
      if (targetIds) targetIds.forEach(function(id) { collectedIds.add(id); });

      if (targetPycs && targetPycs.length) {
        if (isConference) {
          const { data: pycRows } = await supabase
            .from('registrations')
            .select('id, confirmation_number')
            .in('confirmation_number', targetPycs);
          const foundPycs = new Set();
          (pycRows || []).forEach(function(r) {
            collectedIds.add(r.id);
            foundPycs.add((r.confirmation_number || '').toUpperCase());
          });
          targetPycs.forEach(function(p) { if (!foundPycs.has(p)) notFoundIdentifiers.push(p); });
        } else {
          // Accommodation: PYC lives on the linked registration. Look up registration_id -> reservation
          const { data: regRows } = await supabase
            .from('registrations')
            .select('id, confirmation_number')
            .in('confirmation_number', targetPycs);
          const regIdToPyc = {};
          (regRows || []).forEach(function(r) { regIdToPyc[r.id] = r.confirmation_number; });
          const regIds = Object.keys(regIdToPyc);
          const foundPycs = new Set();
          if (regIds.length > 0) {
            const { data: resRows } = await supabase
              .from('accommodation_reservations')
              .select('id, registration_id')
              .in('registration_id', regIds);
            (resRows || []).forEach(function(r) {
              collectedIds.add(r.id);
              foundPycs.add((regIdToPyc[r.registration_id] || '').toUpperCase());
            });
          }
          targetPycs.forEach(function(p) { if (!foundPycs.has(p)) notFoundIdentifiers.push(p); });
        }
      }

      if (targetEmails && targetEmails.length) {
        const emailCol = isConference ? 'email' : 'registrant_email';
        const { data: emailRows } = await supabase
          .from(tableName)
          .select('id, ' + emailCol)
          .in(emailCol, targetEmails);
        const foundEmails = new Set();
        (emailRows || []).forEach(function(r) {
          collectedIds.add(r.id);
          foundEmails.add((r[emailCol] || '').toLowerCase());
        });
        targetEmails.forEach(function(e) { if (!foundEmails.has(e)) notFoundIdentifiers.push(e); });
      }

      const finalIds = Array.from(collectedIds);
      if (finalIds.length > 0) {
        const { data } = await supabase
          .from(tableName)
          .select(selectCols)
          .in('id', finalIds);
        candidates = data || [];
      }
      totalCount = candidates.length;
      totalNoWindow = candidates.length;
    } else if (emailType === 'conference_confirmation') {
      const baseFilter = function(q) {
        return q
          .in('payment_status', ['Pending Review', 'Resubmitted', 'Paid'])
          .not('confirmation_number', 'is', null)
          .or('is_primary.eq.true,registration_type.eq.individual');
      };
      const diagRes = await baseFilter(supabase
        .from('registrations')
        .select('id', { count: 'exact', head: true }));
      totalNoWindow = diagRes.count || 0;

      let q = supabase
        .from('registrations')
        .select('id, first_name, last_name, email, confirmation_number, payment_status, total_amount, meal_plan, group_id, is_primary, registration_type, created_at, age', { count: 'exact' });
      q = baseFilter(q);
      if (windowStart) q = q.gte('created_at', windowStart);
      q = q.order('created_at', { ascending: true }).range(offset, offset + limit - 1);

      const { data, count } = await q;
      candidates = data || [];
      totalCount = count || 0;

    } else if (emailType === 'conference_approval') {
      const baseFilter = function(q) {
        return q
          .eq('payment_status', 'Paid')
          .not('confirmation_number', 'is', null)
          .or('is_primary.eq.true,registration_type.eq.individual');
      };
      const diagRes = await baseFilter(supabase
        .from('registrations')
        .select('id', { count: 'exact', head: true }));
      totalNoWindow = diagRes.count || 0;

      let q = supabase
        .from('registrations')
        .select('id, first_name, last_name, email, confirmation_number, payment_status, total_amount, meal_plan, group_id, is_primary, registration_type, created_at, age', { count: 'exact' });
      q = baseFilter(q);
      if (windowStart) q = q.gte('created_at', windowStart);
      q = q.order('created_at', { ascending: true }).range(offset, offset + limit - 1);

      const { data, count } = await q;
      candidates = data || [];
      totalCount = count || 0;

    } else if (emailType === 'accommodation_pending') {
      const baseFilter = function(q) {
        return q.in('payment_status', ['Pending Review', 'Resubmitted']);
      };
      const diagRes = await baseFilter(supabase
        .from('accommodation_reservations')
        .select('id', { count: 'exact', head: true }));
      totalNoWindow = diagRes.count || 0;

      let q = supabase
        .from('accommodation_reservations')
        .select('*', { count: 'exact' });
      q = baseFilter(q);
      if (windowStart) q = q.gte('created_at', windowStart);
      q = q.order('created_at', { ascending: true }).range(offset, offset + limit - 1);

      const { data, count } = await q;
      candidates = data || [];
      totalCount = count || 0;

    } else if (emailType === 'accommodation_approved') {
      const baseFilter = function(q) {
        return q.eq('payment_status', 'Paid');
      };
      const diagRes = await baseFilter(supabase
        .from('accommodation_reservations')
        .select('id', { count: 'exact', head: true }));
      totalNoWindow = diagRes.count || 0;

      let q = supabase
        .from('accommodation_reservations')
        .select('*', { count: 'exact' });
      q = baseFilter(q);
      if (windowStart) q = q.gte('created_at', windowStart);
      q = q.order('created_at', { ascending: true }).range(offset, offset + limit - 1);

      const { data, count } = await q;
      candidates = data || [];
      totalCount = count || 0;
    }

    if (dryRun) {
      const items = candidates.map(function(c) {
        if (emailType.startsWith('conference')) {
          return {
            id: c.id,
            name: ((c.first_name || '') + ' ' + (c.last_name || '')).trim(),
            email: c.email,
            pyc: c.confirmation_number,
            status: c.payment_status,
            created_at: c.created_at
          };
        } else {
          return {
            id: c.id,
            name: c.registrant_name,
            email: c.registrant_email,
            type: c.accommodation_type,
            spots: c.spots_requested,
            status: c.payment_status,
            created_at: c.created_at
          };
        }
      });
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          dryRun: true,
          emailType: emailType,
          windowStart: windowStart,
          windowApplied: !!windowStart,
          total: totalCount,
          totalNoWindow: totalNoWindow,
          notFound: notFoundIdentifiers,
          offset: offset,
          limit: limit,
          items: items
        })
      };
    }

    const results = { sent: [], failed: [] };
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      try {
        if (emailType === 'conference_confirmation') {
          await sendConfirmationEmail(c, 'GCash');
        } else if (emailType === 'conference_approval') {
          let hasMinorInGroup = false;
          if (c.group_id) {
            const { data: members } = await supabase
              .from('registrations')
              .select('age')
              .eq('group_id', c.group_id);
            hasMinorInGroup = (members || []).some(function(m) { return m.age && parseInt(m.age) < 18; });
          } else if (c.age && parseInt(c.age) < 18) {
            hasMinorInGroup = true;
          }
          await sendApprovalReceiptEmail(c, hasMinorInGroup);
        } else if (emailType === 'accommodation_pending') {
          await sendPendingEmail(c);
        } else if (emailType === 'accommodation_approved') {
          await sendApprovedEmail(c);
        }
        results.sent.push({
          id: c.id,
          name: c.first_name ? (c.first_name + ' ' + c.last_name) : c.registrant_name,
          email: c.email || c.registrant_email
        });
      } catch (err) {
        console.error('Resend failed for ' + (c.id || '?') + ':', err.message);
        results.failed.push({
          id: c.id,
          name: c.first_name ? (c.first_name + ' ' + c.last_name) : c.registrant_name,
          email: c.email || c.registrant_email,
          error: err.message
        });
      }
      if (i < candidates.length - 1) {
        await new Promise(function(r) { setTimeout(r, 100); });
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        dryRun: false,
        emailType: emailType,
        windowStart: windowStart,
        windowApplied: !!windowStart,
        total: totalCount,
        totalNoWindow: totalNoWindow,
        notFound: notFoundIdentifiers,
        offset: offset,
        limit: limit,
        processed: candidates.length,
        sentCount: results.sent.length,
        failedCount: results.failed.length,
        sent: results.sent,
        failed: results.failed,
        hasMore: (offset + candidates.length) < totalCount
      })
    };
  } catch (err) {
    console.error('resend-emails error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error: ' + err.message }) };
  }
};
