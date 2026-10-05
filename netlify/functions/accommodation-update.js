const { createClient } = require('@supabase/supabase-js');

const VALID_TYPES = ['girls_dorm', 'boys_dorm', 'camping'];
const VALID_ACTIONS = ['cancel', 'change_type'];

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    if (event.body && event.body.length > 2000) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Request too large' }) };
    }

    let parsed;
    try { parsed = JSON.parse(event.body); } catch (e) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) };
    }

    const { reservationId, action, newType, notes } = parsed;

    if (!reservationId || typeof reservationId !== 'string' || reservationId.length > 50) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid reservation ID required' }) };
    }
    if (!VALID_ACTIONS.includes(action)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid action' }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const cleanNotes = (notes || '').substring(0, 500);

    if (action === 'cancel') {
      const { error } = await supabase
        .from('accommodation_reservations')
        .update({ payment_status: 'Cancelled', notes: cleanNotes || 'Cancelled by admin', updated_at: new Date().toISOString() })
        .eq('id', reservationId);
      if (error) {
        console.error('Cancel error:', error.message);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to cancel' }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Reservation cancelled' }) };
    }

    if (action === 'change_type') {
      if (!newType || !VALID_TYPES.includes(newType)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid accommodation type' }) };
      }

      // Fetch current reservation to get spots_requested
      const { data: current, error: fetchErr } = await supabase
        .from('accommodation_reservations')
        .select('spots_requested')
        .eq('id', reservationId)
        .single();

      if (fetchErr || !current) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Reservation not found' }) };
      }

      // Check availability of new type
      const { data: avail } = await supabase
        .from('accommodation_availability')
        .select('*')
        .eq('id', newType)
        .single();

      if (!avail || avail.spots_remaining < current.spots_requested) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'New accommodation type does not have enough spots' }) };
      }

      // Recalculate total with correct spots
      const newTotal = avail.price_per_spot * current.spots_requested;

      const { error } = await supabase
        .from('accommodation_reservations')
        .update({ 
          accommodation_type: newType, 
          price_per_spot: avail.price_per_spot,
          total_amount: newTotal,
          notes: cleanNotes || 'Type changed by admin',
          updated_at: new Date().toISOString()
        })
        .eq('id', reservationId);

      if (error) {
        console.error('Change type error:', error.message);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to change type' }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Accommodation type changed' }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid action' }) };
  } catch (error) {
    console.error('Accommodation update error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
