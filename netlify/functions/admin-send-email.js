// admin-send-email.js
//
// Manually trigger a single transactional email to one person. Used by the
// master dashboard's per-person "Send Email" panel for cases where an email
// didn't go through (delivery failure, bounce) or the admin wants to resend.
//
// Strict status validation — no overrides:
//   - registration_confirmation → requires payment_status === 'Pending Review'
//   - registration_approval     → requires payment_status === 'Paid'
//   - registration_rejection    → requires payment_status === 'Rejected'
//   - accommodation_pending     → requires reservation.payment_status === 'Pending Review'
//   - accommodation_approved    → requires reservation.payment_status === 'Paid'
//   - accommodation_rejected    → requires reservation.payment_status === 'Rejected'
//
// All emails go through the existing email-helper / accommodation-email-helper
// templates — this function does not duplicate any template HTML. If a template
// changes, the manual send flow picks it up automatically.

const { createClient } = require('@supabase/supabase-js');
const { sendConfirmationEmail, sendApprovalReceiptEmail, sendRejectionEmail } = require('./email-helper');
const { sendPendingEmail, sendApprovedEmail, sendRejectedEmail } = require('./accommodation-email-helper');

// Map: emailType → { source, requiredStatus, kind }
// source: 'registration' (looks up registrations table) or 'accommodation' (looks up accommodation_reservations)
// requiredStatus: payment_status the record MUST have for this email to be sent
// kind: which helper function to invoke
const EMAIL_RULES = {
  registration_confirmation: { source: 'registration',  requiredStatus: 'Pending Review', kind: 'reg_confirmation' },
  registration_approval:     { source: 'registration',  requiredStatus: 'Paid',           kind: 'reg_approval' },
  registration_rejection:    { source: 'registration',  requiredStatus: 'Rejected',       kind: 'reg_rejection' },
  accommodation_pending:     { source: 'accommodation', requiredStatus: 'Pending Review', kind: 'accom_pending' },
  accommodation_approved:    { source: 'accommodation', requiredStatus: 'Paid',           kind: 'accom_approved' },
  accommodation_rejected:    { source: 'accommodation', requiredStatus: 'Rejected',       kind: 'accom_rejected' }
};

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    const emailType = String(body.emailType || '').trim();
    const registrationId = body.registrationId ? String(body.registrationId).trim() : null;
    const reservationId = body.reservationId ? String(body.reservationId).trim() : null;

    const rule = EMAIL_RULES[emailType];
    if (!rule) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown emailType: ' + emailType }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    if (rule.source === 'registration') {
      if (!registrationId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'registrationId is required for ' + emailType }) };
      }
      const { data: reg, error: regErr } = await supabase
        .from('registrations')
        .select('*')
        .eq('id', registrationId)
        .single();
      if (regErr || !reg) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Registration not found' }) };
      }
      // Strict status gate — no overrides
      if (reg.payment_status !== rule.requiredStatus) {
        return { statusCode: 409, headers, body: JSON.stringify({
          error: `Cannot send this email: registration's current payment_status is "${reg.payment_status || '(none)'}" but this email requires "${rule.requiredStatus}".`,
          actualStatus: reg.payment_status,
          requiredStatus: rule.requiredStatus
        }) };
      }
      // Email field must be present
      if (!reg.email) {
        return { statusCode: 422, headers, body: JSON.stringify({ error: 'Registration has no email address on file.' }) };
      }

      try {
        if (rule.kind === 'reg_confirmation') {
          await sendConfirmationEmail(reg, reg.payment_method || 'GCash');
        } else if (rule.kind === 'reg_approval') {
          // Compute hasMinorInGroup like resend-emails.js does
          let hasMinorInGroup = false;
          if (reg.group_id) {
            const { data: members } = await supabase
              .from('registrations')
              .select('age')
              .eq('group_id', reg.group_id);
            hasMinorInGroup = (members || []).some(m => m.age && parseInt(m.age) < 18);
          } else if (reg.age && parseInt(reg.age) < 18) {
            hasMinorInGroup = true;
          }
          await sendApprovalReceiptEmail(reg, hasMinorInGroup);
        } else if (rule.kind === 'reg_rejection') {
          await sendRejectionEmail(reg);
        }
      } catch (sendErr) {
        console.error('[admin-send-email] send failed:', sendErr);
        return { statusCode: 502, headers, body: JSON.stringify({ error: 'Email provider rejected the send: ' + (sendErr.message || 'unknown error') }) };
      }

      return { statusCode: 200, headers, body: JSON.stringify({
        success: true,
        sentTo: reg.email,
        sentToName: `${reg.first_name || ''} ${reg.last_name || ''}`.trim(),
        emailType: emailType
      }) };
    }

    // Accommodation source
    if (rule.source === 'accommodation') {
      if (!reservationId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'reservationId is required for ' + emailType }) };
      }
      const { data: res, error: resErr } = await supabase
        .from('accommodation_reservations')
        .select('*')
        .eq('id', reservationId)
        .single();
      if (resErr || !res) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Reservation not found' }) };
      }
      if (res.payment_status !== rule.requiredStatus) {
        return { statusCode: 409, headers, body: JSON.stringify({
          error: `Cannot send this email: reservation's current payment_status is "${res.payment_status || '(none)'}" but this email requires "${rule.requiredStatus}".`,
          actualStatus: res.payment_status,
          requiredStatus: rule.requiredStatus
        }) };
      }
      if (!res.registrant_email) {
        return { statusCode: 422, headers, body: JSON.stringify({ error: 'Reservation has no registrant_email on file.' }) };
      }

      try {
        if (rule.kind === 'accom_pending') await sendPendingEmail(res);
        else if (rule.kind === 'accom_approved') await sendApprovedEmail(res);
        else if (rule.kind === 'accom_rejected') await sendRejectedEmail(res);
      } catch (sendErr) {
        console.error('[admin-send-email] accommodation send failed:', sendErr);
        return { statusCode: 502, headers, body: JSON.stringify({ error: 'Email provider rejected the send: ' + (sendErr.message || 'unknown error') }) };
      }

      return { statusCode: 200, headers, body: JSON.stringify({
        success: true,
        sentTo: res.registrant_email,
        sentToName: res.registrant_name || '',
        emailType: emailType,
        accommodationType: res.accommodation_type
      }) };
    }

    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Unhandled source: ' + rule.source }) };

  } catch (e) {
    console.error('[admin-send-email] error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message || 'Internal error' }) };
  }
};
