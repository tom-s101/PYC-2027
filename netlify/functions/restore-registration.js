const { createClient } = require('@supabase/supabase-js');
const { sendRestoreEmail } = require('./email-helper');

exports.handler = async (event, context) => {
  // CORS — match approve-payment.js pattern
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { registrationId } = JSON.parse(event.body);

    if (!registrationId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing registrationId' }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Fetch the rejected registration first
    const { data: registration, error: fetchError } = await supabase
      .from('registrations')
      .select('*')
      .eq('id', registrationId)
      .single();

    if (fetchError || !registration) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Registration not found' }) };
    }

    if (registration.payment_status !== 'Rejected') {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'This registration is not in Rejected status. Current status: ' + (registration.payment_status || 'Pending') })
      };
    }

    // Restore: set status back to Pending Review
    const { error: updateError } = await supabase
      .from('registrations')
      .update({
        payment_status: 'Pending Review'
      })
      .eq('id', registrationId);

    if (updateError) {
      console.error('Update error:', updateError.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to restore: ' + updateError.message }) };
    }

    // Send notification email — non-fatal if it fails
    try {
      await sendRestoreEmail(registration);
    } catch (emailErr) {
      console.error('Restore email failed (non-fatal):', emailErr.message);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: registration.first_name + ' ' + registration.last_name + ' has been restored to Pending Review.'
      })
    };
  } catch (err) {
    console.error('restore-registration error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error: ' + err.message }) };
  }
};
