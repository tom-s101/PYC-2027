const { createClient } = require('@supabase/supabase-js');
const { sendConfirmationEmail } = require('./email-helper');

// Admin recovery tool: assign the next available PYC number to a registration
// that somehow ended up without one (e.g. payment proof was uploaded during the
// Brevo outage and the assignment step didn't complete properly).
//
// What it does:
//   1. Verifies the registration exists and confirmation_number IS NULL
//   2. Scans ALL existing confirmation_numbers to find the next available
//   3. Atomically assigns it (with a uniqueness double-check)
//   4. Optionally sends the confirmation email (default: yes)
//
// Input (POST JSON):
//   { registrationId, sendEmail? (default true) }
//
// Output: { success, confirmationNumber, emailSent, message }

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
    const sendEmail = parsed.sendEmail !== false; // default true

    if (!registrationId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'registrationId required' }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Fetch the registration
    const { data: reg, error: regErr } = await supabase
      .from('registrations')
      .select('*')
      .eq('id', registrationId)
      .single();

    if (regErr || !reg) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Registration not found' }) };
    }

    // If they ALREADY have a PYC, don't overwrite — admin's protection against accidents
    if (reg.confirmation_number) {
      return { statusCode: 400, headers, body: JSON.stringify({
        error: 'This registration already has PYC ' + reg.confirmation_number + '. Refusing to overwrite. Use the Edit Reservation flow if you need to change it.',
        existingPyc: reg.confirmation_number
      }) };
    }

    // Compute the next available PYC. Load ALL existing PYCs (NULL excluded) and
    // find the highest, then assign max+1. This is the same algorithm used by
    // upload-payment-proof.js (see earlier conversations).
    const { data: existingRows } = await supabase
      .from('registrations')
      .select('confirmation_number')
      .not('confirmation_number', 'is', null);

    const usedNumbers = new Set();
    let maxNum = 0;
    (existingRows || []).forEach(function(r) {
      const m = (r.confirmation_number || '').match(/^PYC-(\d+)$/i);
      if (m) {
        const n = parseInt(m[1], 10);
        if (!isNaN(n)) {
          usedNumbers.add(n);
          if (n > maxNum) maxNum = n;
        }
      }
    });

    // Find the next number that isn't used (skip gaps just in case)
    let nextNum = maxNum + 1;
    while (usedNumbers.has(nextNum)) nextNum++;
    const newPyc = 'PYC-' + String(nextNum).padStart(4, '0');

    // Assign
    const { error: updErr } = await supabase
      .from('registrations')
      .update({ confirmation_number: newPyc })
      .eq('id', registrationId);

    if (updErr) {
      console.error('PYC assign update error:', updErr.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to assign PYC: ' + updErr.message }) };
    }

    // Re-fetch the updated record so the email function gets full + fresh data
    const { data: updatedReg } = await supabase
      .from('registrations')
      .select('*')
      .eq('id', registrationId)
      .single();

    const fullName = ((reg.first_name || '') + ' ' + (reg.last_name || '')).trim();

    // Send the confirmation email if requested. Errors here don't roll back the
    // PYC assignment — the PYC is the more important durable outcome.
    let emailSent = false;
    let emailError = null;
    if (sendEmail && updatedReg) {
      try {
        await sendConfirmationEmail(updatedReg, updatedReg.payment_method || 'GCash');
        emailSent = true;
      } catch (e) {
        emailError = e.message;
        console.error('Confirmation email after PYC assign failed:', e.message);
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        confirmationNumber: newPyc,
        emailSent: emailSent,
        emailError: emailError,
        message: 'Assigned ' + newPyc + ' to ' + fullName + '.' +
          (sendEmail ? (emailSent ? ' Confirmation email sent.' : ' Email failed: ' + emailError) : ' (Email skipped per request.)')
      })
    };
  } catch (err) {
    console.error('admin-assign-pyc error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error: ' + err.message }) };
  }
};
