const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body);
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Support both old and new field names
    const registrantId = body.registrantId || body.recordId;
    const action = body.action || 'checkin';

    if (!registrantId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing registrant ID' }) };
    }

    const isCheckin = action === 'checkin';

    // Check in individual
    const { data: record, error: updateError } = await supabase
      .from('registrations')
      .update({
        checked_in: isCheckin,
        checked_in_at: isCheckin ? new Date().toISOString() : null
      })
      .eq('id', registrantId)
      .select()
      .single();

    if (updateError) {
      console.error('Check-in error:', updateError);
      throw new Error('Check-in failed: ' + updateError.message);
    }

    // If this person is in a group, return group info
    let groupMembers = [];
    if (record && record.group_id) {
      const { data: members } = await supabase
        .from('registrations')
        .select('id, first_name, last_name, checked_in, tshirt_size, meal_plan, age')
        .eq('group_id', record.group_id)
        .order('is_primary', { ascending: false });
      groupMembers = members || [];
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: isCheckin ? 'Checked in successfully!' : 'Check-in undone',
        record: record,
        groupMembers: groupMembers.length > 1 ? groupMembers : []
      })
    };

  } catch (error) {
    console.error('Admin checkin error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
