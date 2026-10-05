const { createClient } = require('@supabase/supabase-js');
const { sendPendingEmail, sendPendingEmailBatch } = require('./accommodation-email-helper');

// Rate limiting
const uploadAttempts = new Map();
const MAX_UPLOADS = 5;
const WINDOW_MS = 10 * 60 * 1000;

function isRateLimited(ip) {
  const now = Date.now();
  const data = uploadAttempts.get(ip);
  if (!data || now - data.windowStart > WINDOW_MS) {
    uploadAttempts.set(ip, { count: 1, windowStart: now });
    return false;
  }
  data.count++;
  return data.count > MAX_UPLOADS;
}

const ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    // Rate limit
    const clientIP = event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown';
    if (isRateLimited(clientIP)) {
      return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too many uploads. Please wait.' }) };
    }

    let parsed;
    try { parsed = JSON.parse(event.body); } catch (e) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) };
    }

    let { reservationId, imageBase64, fileName, paymentMethod, paymentAccount, isWaitlist, waitlistId, transactionReference, cartItems, registrationId: cartRegId, registrantName: cartName, registrantEmail: cartEmail } = parsed;

    // Defense in depth: frontend enforces these but also enforce on server to prevent
    // reservations being created with missing proof / reference number (e.g. via direct
    // API calls or JS disabled).
    if (!imageBase64 || typeof imageBase64 !== 'string' || imageBase64.length < 100) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid payment proof image is required.' }) };
    }
    const refTrimmed = (transactionReference || '').trim();
    if (!refTrimmed) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Transaction reference number is required.' }) };
    }
    // Re-pack the cleaned reference so the rest of the handler uses it
    transactionReference = refTrimmed;

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    let allReservationIds = [];

    // Cart-based submission: create reservations from cart items
    if (cartItems && Array.isArray(cartItems) && cartItems.length > 0 && !reservationId) {
      // Prevent over-reservation: total spots reserved (existing + new) must not exceed
      // the total number of people registered under this email.
      //
      // A user may register multiple groups under the same email over time (e.g. a
      // youth leader registering different batches). All people registered under this
      // email count toward their max spot quota — we count across ALL registrations
      // (not just the current group's members), which matches how we count existing
      // reservations (also across the whole email).
      if (cartEmail) {
        try {
          // Count all people this email has registered (across any number of groups)
          const { data: allRegs } = await supabase
            .from('registrations')
            .select('id')
            .ilike('email', cartEmail);
          const memberCount = (allRegs || []).length || 1;

          // Sum existing reservation spots for this email (only proof-uploaded ones count)
          const { data: existingRes } = await supabase
            .from('accommodation_reservations')
            .select('spots_requested')
            .ilike('registrant_email', cartEmail)
            .in('payment_status', ['Pending Review', 'Resubmitted', 'Paid']);
          const existingSpots = (existingRes || []).reduce(function(sum, r) {
            return sum + (parseInt(r.spots_requested) || 0);
          }, 0);

          // Sum new cart spots
          const newSpots = cartItems.reduce(function(sum, item) {
            return sum + (parseInt(item.spots) || 0);
          }, 0);

          if (existingSpots + newSpots > memberCount) {
            const remaining = Math.max(0, memberCount - existingSpots);
            const msg = existingSpots === 0
              ? 'You have ' + memberCount + ' registered person(s) under this email, but you\'re trying to reserve ' + newSpots + ' spot(s). Please reduce your cart.'
              : 'You have ' + memberCount + ' registered person(s) under this email. You\'ve already reserved ' + existingSpots + ' spot(s) and have ' + remaining + ' remaining. You\'re trying to add ' + newSpots + ' more. Please reduce your cart.';
            return { statusCode: 409, headers, body: JSON.stringify({ error: msg }) };
          }
        } catch (groupCheckErr) {
          console.error('Spot cap check error (non-fatal, allowing reservation):', groupCheckErr.message);
          // If the check fails for some reason, don't block the reservation
        }
      }

      // Validate and decrement spots for each cart item
      for (const item of cartItems) {
        const { data: avail, error: availErr } = await supabase
          .from('accommodation_availability')
          .select('spots_remaining, price_per_spot')
          .eq('id', item.accommodationType)
          .single();

        if (availErr || !avail) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Accommodation type not found: ' + item.displayName }) };
        }
        if (avail.spots_remaining < item.spots) {
          return { statusCode: 409, headers, body: JSON.stringify({
            error: "We're sorry — " + item.displayName + " became fully booked while you were completing payment. Please contact us through our social media (Facebook: @Philippine Youth for Christ) to arrange a refund.",
            fullyBooked: true
          }) };
        }

        // Create reservation record (spots are tracked via reservations — the availability view computes remaining automatically)
        const { data: newRes, error: resErr } = await supabase
          .from('accommodation_reservations')
          .insert([{
            registration_id: cartRegId || null,
            registrant_name: cartName || 'Unknown',
            registrant_email: cartEmail || '',
            accommodation_type: item.accommodationType,
            spots_requested: item.spots,
            price_per_spot: avail.price_per_spot,
            total_amount: item.spots * avail.price_per_spot,
            payment_status: 'Pending Review',
            payment_account: paymentAccount || 'A',
            payment_method: paymentMethod || 'GCash'
          }])
          .select()
          .single();

        if (resErr) {
          console.error('Reservation create error:', resErr.message);
          return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to create reservation for ' + item.displayName }) };
        }
        allReservationIds.push(newRes.id);
        console.log('Created reservation', newRes.id, 'for', item.displayName, item.spots, 'spots');
      }

      // Use first reservation as the primary for proof upload
      reservationId = allReservationIds[0];
    }

    // Handle waitlist payment: create a real reservation first
    if (isWaitlist && waitlistId) {
      try {
        const { data: wEntry, error: wErr } = await supabase
          .from('accommodation_waitlist')
          .select('*')
          .eq('id', waitlistId)
          .single();

        if (wErr || !wEntry) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Waitlist entry not found' }) };
        }
        if (wEntry.status !== 'Notified') {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'This waitlist entry has not been notified yet' }) };
        }
        if (wEntry.notified_expires_at && new Date(wEntry.notified_expires_at) < new Date()) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Your 48-hour payment window has expired' }) };
        }

        const { data: accommType } = await supabase
          .from('accommodation_types')
          .select('price_per_spot')
          .eq('id', wEntry.accommodation_type)
          .single();
        const pricePerSpot = accommType ? accommType.price_per_spot : 0;
        const totalAmount = pricePerSpot * wEntry.spots_requested;

        const { data: newRes, error: resErr } = await supabase
          .from('accommodation_reservations')
          .insert([{
            registrant_name: wEntry.registrant_name,
            registrant_email: wEntry.registrant_email,
            registration_id: wEntry.registration_id,
            accommodation_type: wEntry.accommodation_type,
            spots_requested: wEntry.spots_requested,
            total_amount: totalAmount,
            payment_account: paymentAccount || 'A',
            payment_status: 'Pending Review',
            notes: 'Converted from waitlist'
          }])
          .select()
          .single();

        if (resErr) {
          console.error('Waitlist conversion error:', resErr.message);
          return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to create reservation' }) };
        }

        await supabase
          .from('accommodation_waitlist')
          .update({ status: 'Converted', converted_reservation_id: newRes.id, updated_at: new Date().toISOString() })
          .eq('id', waitlistId);

        reservationId = newRes.id;
      } catch (wError) {
        console.error('Waitlist processing error:', wError.message);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
      }
    }

    if (!reservationId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Reservation ID required' }) };
    }

    // Validate reservation ID format (UUID)
    if (typeof reservationId !== 'string' || reservationId.length > 50) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid reservation ID' }) };
    }

    // Validate file extension
    const ext = fileName ? fileName.split('.').pop().toLowerCase() : 'jpg';
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Only JPG, PNG, and WebP images allowed' }) };
    }

    // Process and validate image size
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    if (buffer.length > MAX_FILE_SIZE) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'File too large. Maximum 5MB.' }) };
    }

    // Validate it looks like an actual image (check magic bytes)
    const magicBytes = buffer.slice(0, 4);
    const isJPG = magicBytes[0] === 0xFF && magicBytes[1] === 0xD8;
    const isPNG = magicBytes[0] === 0x89 && magicBytes[1] === 0x50 && magicBytes[2] === 0x4E && magicBytes[3] === 0x47;
    const isWEBP = magicBytes[0] === 0x52 && magicBytes[1] === 0x49; // RIFF header

    if (!isJPG && !isPNG && !isWEBP) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid image file' }) };
    }


    // Verify reservation exists
    const { data: record, error: fetchError } = await supabase
      .from('accommodation_reservations')
      .select('*')
      .eq('id', reservationId)
      .single();

    if (fetchError || !record) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Reservation not found' }) };
    }

    const timestamp = Date.now();
    const storagePath = `accommodation-proofs/${reservationId}_${timestamp}.${ext}`;

    // Upload to Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from('payment-proofs')
      .upload(storagePath, buffer, {
        contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
        upsert: true
      });

    if (uploadError) {
      console.error('Upload error:', uploadError.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to upload image' }) };
    }

    const { data: urlData } = supabase.storage
      .from('payment-proofs')
      .getPublicUrl(storagePath);

    // Determine if this is a resubmission
    const isResubmission = record.payment_status === 'Rejected' || record.payment_status === 'Resubmitted';

    // Decrement spots only on first payment upload (not resubmissions - spot already claimed)
    // Also skip if cart-based — spots were already decremented during reservation creation above
    const isCartBased = allReservationIds.length > 0;
    if (!isResubmission && !isCartBased) {
      const { data: avail, error: availErr } = await supabase
        .from('accommodation_availability')
        .select('spots_remaining')
        .eq('id', record.accommodation_type)
        .single();

      if (availErr || !avail) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Accommodation type not found' }) };
      }

      if (avail.spots_remaining < record.spots_requested) {
        return { statusCode: 409, headers, body: JSON.stringify({ 
          error: 'We\'re sorry — this accommodation became fully booked while you were completing payment. Please contact us through our social media (Facebook: @Philippine Youth for Christ) to arrange a refund.',
          fullyBooked: true
        }) };
      }

      const { error: decError } = await supabase
        .from('accommodation_availability')
        .update({ spots_remaining: avail.spots_remaining - record.spots_requested })
        .eq('id', record.accommodation_type);

      if (decError) {
        console.error('Spots decrement error:', decError.message);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to reserve spots' }) };
      }
      console.log('Spots decremented for', record.accommodation_type, 'by', record.spots_requested);
    }

    // Sanitize payment method
    const validMethods = ['GCash', 'Bank Transfer'];
    const cleanMethod = validMethods.includes(paymentMethod) ? paymentMethod : 'GCash';
    const validAccounts = ['A', 'B', 'bank_bpi', 'bank_gotyme'];
    const cleanAccount = validAccounts.includes(paymentAccount) ? paymentAccount : record.payment_account;

    // Update reservation(s) with proof
    const updatePayload = {
        payment_proof_url: urlData.publicUrl,
        payment_proof_uploaded_at: new Date().toISOString(),
        payment_status: isResubmission ? 'Resubmitted' : 'Pending Review',
        payment_method: cleanMethod,
        transaction_reference: (transactionReference || '').substring(0, 100) || null,
        payment_account: cleanAccount,
        updated_at: new Date().toISOString()
    };

    // If cart-based, update ALL reservation IDs
    const idsToUpdate = allReservationIds.length > 0 ? allReservationIds : [reservationId];
    for (const rid of idsToUpdate) {
      const { error: updateError } = await supabase
        .from('accommodation_reservations')
        .update(updatePayload)
        .eq('id', rid);
      if (updateError) {
        console.error('Update error for', rid, ':', updateError.message);
      }
    }

    // Send pending email (non-blocking). For multi-item cart, send ONE combined email.
    try {
      if (idsToUpdate.length > 1) {
        // Multi-reservation cart: fetch all reservations and send one combined email
        const { data: allReservations } = await supabase
          .from('accommodation_reservations')
          .select('*')
          .in('id', idsToUpdate);
        if (allReservations && allReservations.length > 0) {
          await sendPendingEmailBatch(allReservations);
        } else {
          // Fallback: single email with primary record
          const updatedRecord = { ...record,
            payment_proof_url: urlData.publicUrl,
            payment_method: cleanMethod,
            payment_status: isResubmission ? 'Resubmitted' : 'Pending Review'
          };
          await sendPendingEmail(updatedRecord);
        }
      } else {
        const updatedRecord = { ...record,
          payment_proof_url: urlData.publicUrl,
          payment_method: cleanMethod,
          payment_status: isResubmission ? 'Resubmitted' : 'Pending Review'
        };
        await sendPendingEmail(updatedRecord);
      }
    } catch (emailErr) {
      console.error('Email send error (non-fatal):', emailErr.message);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, isResubmission, message: isResubmission ? 'Payment proof resubmitted!' : 'Payment proof uploaded!' })
    };
  } catch (error) {
    console.error('Upload accommodation proof error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
