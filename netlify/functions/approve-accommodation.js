const { createClient } = require('@supabase/supabase-js');
const { sendApprovedEmail, sendRejectedEmail, sendApprovedEmailBatch, sendRejectedEmailBatch } = require('./accommodation-email-helper');

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    if (event.body && event.body.length > 1000) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Request too large' }) };
    }

    let parsed;
    try { parsed = JSON.parse(event.body); } catch (e) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) };
    }

    const { reservationId, approve } = parsed;

    if (!reservationId || typeof reservationId !== 'string' || reservationId.length > 50) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid reservation ID required' }) };
    }
    if (typeof approve !== 'boolean') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Approve must be true or false' }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Fetch the clicked reservation first (to get its proof URL and email)
    const { data: reservation, error: fetchError } = await supabase
      .from('accommodation_reservations')
      .select('*')
      .eq('id', reservationId)
      .single();

    if (fetchError || !reservation) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Reservation not found' }) };
    }

    const newStatus = approve ? 'Paid' : 'Rejected';

    // Guard: if this reservation is already in the target state, it was processed by a
    // previous click (likely approving a sibling from the same cart handled this one too).
    // Return success without re-sending email — prevents duplicates.
    if (reservation.payment_status === newStatus) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          reservationsUpdated: 0,
          message: 'Already ' + newStatus + ' (likely processed via sibling reservation).'
        })
      };
    }

    // Find all SIBLING reservations from the same cart upload.
    // They share the same payment_proof_url (set at upload time for every item in cart)
    // AND the same registrant_email. Only include ones in the same reviewable state.
    // For approval: siblings in Pending Review OR Resubmitted get promoted to Paid together.
    // For rejection: siblings in Pending Review OR Resubmitted get Rejected together.
    let allReservations = [reservation];
    if (reservation.payment_proof_url && reservation.registrant_email) {
      const { data: siblings } = await supabase
        .from('accommodation_reservations')
        .select('*')
        .eq('payment_proof_url', reservation.payment_proof_url)
        .eq('registrant_email', reservation.registrant_email)
        .in('payment_status', ['Pending Review', 'Resubmitted']);

      if (siblings && siblings.length > 0) {
        // De-duplicate (the clicked reservation is already in the list)
        const ids = new Set([reservation.id]);
        allReservations = [reservation];
        siblings.forEach(function(s) {
          if (!ids.has(s.id)) { ids.add(s.id); allReservations.push(s); }
        });
      }
    }

    const idsToUpdate = allReservations.map(function(r) { return r.id; });

    // Update all siblings at once
    const { error: updateErr } = await supabase
      .from('accommodation_reservations')
      .update({
        payment_status: newStatus,
        updated_at: new Date().toISOString()
      })
      .in('id', idsToUpdate);

    if (updateErr) {
      console.error('Approval error:', updateErr.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to update reservation(s)' }) };
    }

    // Send ONE email covering all reservations (use batch version for multi, single for one)
    try {
      if (allReservations.length > 1) {
        if (approve) await sendApprovedEmailBatch(allReservations);
        else await sendRejectedEmailBatch(allReservations);
      } else {
        if (approve) await sendApprovedEmail(reservation);
        else await sendRejectedEmail(reservation);
      }
    } catch (emailErr) {
      console.error('Email error (non-fatal):', emailErr.message);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        reservationsUpdated: allReservations.length,
        message: approve
          ? `Payment approved and confirmation email sent! (${allReservations.length} reservation${allReservations.length > 1 ? 's' : ''})`
          : `Payment rejected and resubmission email sent! (${allReservations.length} reservation${allReservations.length > 1 ? 's' : ''})`
      })
    };
  } catch (error) {
    console.error('Approve accommodation error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
