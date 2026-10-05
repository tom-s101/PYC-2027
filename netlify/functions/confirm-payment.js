const { createClient } = require('@supabase/supabase-js');
const { sendConfirmationEmail } = require('./email-helper');

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { registrationId, paymentIntentId, paymentMethod } = JSON.parse(event.body);
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Get the registration to check if it's a group
    const { data: record, error: fetchError } = await supabase
      .from('registrations')
      .select('*')
      .eq('id', registrationId)
      .single();

    if (fetchError) {
      console.error('Fetch error:', fetchError);
      throw new Error('Registration not found');
    }

    // Update payment status - if group, update ALL group members
    if (record.group_id) {
      const { error: updateError } = await supabase
        .from('registrations')
        .update({ payment_status: 'Paid', payment_method: paymentMethod || 'Stripe' })
        .eq('group_id', record.group_id);

      if (updateError) {
        console.error('Group update error:', updateError);
        throw new Error('Failed to update group payment status: ' + updateError.message);
      }
    } else {
      const { error: updateError } = await supabase
        .from('registrations')
        .update({ payment_status: 'Paid', payment_method: paymentMethod || 'Stripe' })
        .eq('id', registrationId);

      if (updateError) {
        console.error('Update error:', updateError);
        throw new Error('Failed to update payment status: ' + updateError.message);
      }
    }

    // Send confirmation email (to primary registrant)
    try {
      // Re-fetch the updated record
      const { data: updatedRecord } = await supabase
        .from('registrations')
        .select('*')
        .eq('id', registrationId)
        .single();
      
      if (updatedRecord) {
        await sendConfirmationEmail(updatedRecord, paymentMethod || 'Stripe');
      }
    } catch (emailError) {
      console.error('Email error:', emailError);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'Payment confirmed!' })
    };

  } catch (error) {
    console.error('Confirm payment error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to confirm payment', message: error.message })
    };
  }
};
