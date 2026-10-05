const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    let parsed;
    try { parsed = JSON.parse(event.body); } catch (e) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) };
    }

    const pycNumber = (parsed.pycNumber || '').trim().toUpperCase();
    const companionName = (parsed.companionName || '').trim();

    if (!pycNumber) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'PYC number required' }) };
    }
    if (!companionName) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Companion name required' }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Look up the registration by confirmation number
    const { data: reg, error: regErr } = await supabase
      .from('registrations')
      .select('id, first_name, last_name, confirmation_number, payment_status')
      .eq('confirmation_number', pycNumber)
      .single();

    if (regErr || !reg) {
      return { statusCode: 200, headers, body: JSON.stringify({ found: false, message: 'No match found. Check the name and PYC number.' }) };
    }

    // Verify name matches (case-insensitive, compare full name)
    const dbFullName = `${reg.first_name} ${reg.last_name}`.toLowerCase().trim();
    const inputName = companionName.toLowerCase().trim();

    // Allow partial match: input must match either first name, last name, or full name
    const dbFirst = reg.first_name.toLowerCase().trim();
    const dbLast = reg.last_name.toLowerCase().trim();
    const nameMatch = (inputName === dbFullName) ||
                      (inputName === dbFirst + ' ' + dbLast) ||
                      (inputName === dbLast + ', ' + dbFirst) ||
                      (inputName === dbFirst && dbFirst.length >= 2) ||
                      (inputName === dbLast && dbLast.length >= 2) ||
                      (dbFullName.includes(inputName) && inputName.length >= 3);

    if (!nameMatch) {
      // Don't reveal the actual name — just say no match
      return { statusCode: 200, headers, body: JSON.stringify({ found: false, message: 'No match found. Check the name and PYC number.' }) };
    }

    // Check if this person already has a tent reservation WITH PROOF UPLOADED.
    // Only Pending Review / Resubmitted / Paid block — bare 'Pending' (abandoned) does not.
    const { data: existingTents } = await supabase
      .from('tent_reservations')
      .select('registrant_name, members, payment_status')
      .eq('status', 'Active')
      .in('payment_status', ['Pending Review', 'Resubmitted', 'Paid']);

    let alreadyReserved = false;
    let reservedBy = '';
    if (existingTents) {
      for (const tent of existingTents) {
        const members = Array.isArray(tent.members) ? tent.members : [];
        for (const m of members) {
          if (m.pycNumber && m.pycNumber.toUpperCase() === pycNumber) {
            alreadyReserved = true;
            reservedBy = tent.registrant_name;
            break;
          }
        }
        if (alreadyReserved) break;
      }
    }

    // Also check accommodation reservations
    const { data: existingAccomm } = await supabase
      .from('accommodation_reservations')
      .select('registrant_name')
      .eq('registration_id', reg.id)
      .in('status', ['Pending', 'Paid']);

    let hasAccomm = false;
    if (existingAccomm && existingAccomm.length > 0) {
      hasAccomm = true;
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        found: true,
        name: `${reg.first_name} ${reg.last_name}`,
        pycNumber: reg.confirmation_number,
        registrationId: reg.id,
        paymentStatus: reg.payment_status,
        alreadyReserved,
        reservedBy,
        hasAccommodation: hasAccomm
      })
    };
  } catch (err) {
    console.error('Tent lookup error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
