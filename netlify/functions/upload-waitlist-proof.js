const { createClient } = require('@supabase/supabase-js');

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
const MAX_FILE_SIZE = 5 * 1024 * 1024;

exports.handler = async (event, context) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const clientIP = event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown';
    if (isRateLimited(clientIP)) {
      return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too many uploads. Please wait.' }) };
    }

    let parsed;
    try { parsed = JSON.parse(event.body); } catch (e) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) };
    }

    const { waitlistId, imageBase64, fileName, paymentMethod, paymentAccount, transactionReference } = parsed;
    if (!waitlistId || !imageBase64) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    if (typeof waitlistId !== 'string' || waitlistId.length > 50) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid waitlist ID' }) };
    }

    const ext = fileName ? fileName.split('.').pop().toLowerCase() : 'jpg';
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Only JPG, PNG, and WebP images allowed' }) };
    }

    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    if (buffer.length > MAX_FILE_SIZE) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'File too large. Maximum 5MB.' }) };
    }

    const magicBytes = buffer.slice(0, 4);
    const isJPG = magicBytes[0] === 0xFF && magicBytes[1] === 0xD8;
    const isPNG = magicBytes[0] === 0x89 && magicBytes[1] === 0x50 && magicBytes[2] === 0x4E && magicBytes[3] === 0x47;
    const isWEBP = magicBytes[0] === 0x52 && magicBytes[1] === 0x49;
    if (!isJPG && !isPNG && !isWEBP) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid image file' }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Verify waitlist entry exists and is in Offered status
    const { data: entry, error: fetchErr } = await supabase
      .from('accommodation_waitlist')
      .select('*')
      .eq('id', waitlistId)
      .single();

    if (fetchErr || !entry) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Waitlist entry not found' }) };
    }

    if (entry.status !== 'Offered') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'This spot is no longer available for payment.' }) };
    }

    // Check if expired
    if (entry.expires_at && new Date(entry.expires_at) < new Date()) {
      await supabase.from('accommodation_waitlist').update({ status: 'Expired', updated_at: new Date().toISOString() }).eq('id', waitlistId);
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'This offer has expired. Please contact the organizing team.' }) };
    }

    const timestamp = Date.now();
    const storagePath = `waitlist-proofs/${waitlistId}_${timestamp}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('payment-proofs')
      .upload(storagePath, buffer, { contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`, upsert: true });

    if (uploadError) {
      console.error('Upload error:', uploadError.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to upload image' }) };
    }

    const { data: urlData } = supabase.storage.from('payment-proofs').getPublicUrl(storagePath);

    const validMethods = ['GCash', 'Bank Transfer'];
    const cleanMethod = validMethods.includes(paymentMethod) ? paymentMethod : 'GCash';
    const cleanAccount = ['A', 'B'].includes(paymentAccount) ? paymentAccount : entry.payment_account;

    const { error: updateErr } = await supabase
      .from('accommodation_waitlist')
      .update({
        payment_proof_url: urlData.publicUrl,
        payment_proof_uploaded_at: new Date().toISOString(),
        payment_status: 'Pending Review',
        payment_method: cleanMethod,
        transaction_reference: (transactionReference || '').substring(0, 100) || null,
        payment_account: cleanAccount,
        updated_at: new Date().toISOString()
      })
      .eq('id', waitlistId);

    if (updateErr) {
      console.error('Update error:', updateErr.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to update record' }) };
    }

    // Send pending review email (non-blocking)
    try {
      const { sendPendingEmail } = require('./accommodation-email-helper');
      // Build a reservation-like object for the email helper
      await sendPendingEmail({
        registrant_name: entry.registrant_name,
        registrant_email: entry.registrant_email,
        accommodation_type: entry.accommodation_type,
        spots_requested: entry.spots_requested || 1,
        total_amount: entry.total_amount || 0,
        payment_method: cleanMethod,
        payment_account: cleanAccount
      });
    } catch (emailErr) {
      console.error('Email send error (non-blocking):', emailErr.message);
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Payment proof uploaded! Your payment is under review.' }) };
  } catch (error) {
    console.error('Upload waitlist proof error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
