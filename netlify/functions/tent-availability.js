const { createClient } = require('@supabase/supabase-js');

const TOTAL_CANOPIES = 10;
const TENTS_PER_CANOPY = 40;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const { data: tents, error } = await supabase
      .from('tent_reservations')
      .select('canopy_number, tent_size, members, payment_status')
      .eq('status', 'Active')
      .in('payment_status', ['Pending', 'Pending Review', 'Resubmitted', 'Paid']);

    if (error) {
      console.error('Tent availability error:', error.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
    }

    // Build canopy breakdown
    const canopies = [];
    for (let i = 1; i <= TOTAL_CANOPIES; i++) {
      const canopyTents = (tents || []).filter(t => t.canopy_number === i);
      const tentCount = canopyTents.length;
      const peopleCount = canopyTents.reduce((sum, t) => {
        const memberCount = Array.isArray(t.members) ? t.members.length : 0;
        return sum + memberCount;
      }, 0);
      canopies.push({
        canopyNumber: i,
        tentsUsed: tentCount,
        tentsAvailable: TENTS_PER_CANOPY - tentCount,
        totalSpaces: TENTS_PER_CANOPY,
        people: peopleCount
      });
    }

    const totalTentsUsed = (tents || []).length;
    const totalPeople = (tents || []).reduce((sum, t) => {
      return sum + (Array.isArray(t.members) ? t.members.length : 0);
    }, 0);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        totalCanopies: TOTAL_CANOPIES,
        tentsPerCanopy: TENTS_PER_CANOPY,
        totalSpaces: TOTAL_CANOPIES * TENTS_PER_CANOPY,
        totalTentsUsed,
        totalSpacesAvailable: (TOTAL_CANOPIES * TENTS_PER_CANOPY) - totalTentsUsed,
        totalPeople,
        canopies
      })
    };
  } catch (err) {
    console.error('Tent availability error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
