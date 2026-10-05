const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
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

    const { waitlistId, action } = parsed;
    if (!waitlistId || typeof waitlistId !== 'string') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid waitlist ID required' }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Fetch the waitlist entry
    const { data: entry, error: fetchErr } = await supabase
      .from('accommodation_waitlist')
      .select('*')
      .eq('id', waitlistId)
      .single();

    if (fetchErr || !entry) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Waitlist entry not found' }) };
    }

    if (action === 'offer') {
      // Assign a payment account (round-robin)
      const { count } = await supabase
        .from('accommodation_waitlist')
        .select('*', { count: 'exact', head: true })
        .eq('payment_status', 'Pending');
      const paymentAccount = (count !== null && count % 2 === 0) ? 'A' : 'B';

      const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(); // 48 hours

      const { error: updateErr } = await supabase
        .from('accommodation_waitlist')
        .update({
          status: 'Offered',
          payment_status: 'Pending',
          payment_account: paymentAccount,
          notified_at: new Date().toISOString(),
          expires_at: expiresAt,
          updated_at: new Date().toISOString()
        })
        .eq('id', waitlistId);

      if (updateErr) {
        console.error('Offer update error:', updateErr.message);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to offer spot' }) };
      }

      // Send email with payment link
      try {
        const siteUrl = 'https://philippineyouthforchrist.org';
        const paymentLink = `${siteUrl}/waitlist-payment?id=${waitlistId}`;
        
        await sendOfferEmail(entry, paymentLink, paymentAccount);
      } catch (emailErr) {
        console.error('Offer email error (non-fatal):', emailErr.message);
      }

      return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Spot offered! Payment link sent via email.' }) };

    } else if (action === 'cancel') {
      const { error: updateErr } = await supabase
        .from('accommodation_waitlist')
        .update({ status: 'Cancelled', updated_at: new Date().toISOString() })
        .eq('id', waitlistId);

      if (updateErr) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to cancel' }) };
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Removed from waitlist.' }) };

    } else if (action === 'expire') {
      const { error: updateErr } = await supabase
        .from('accommodation_waitlist')
        .update({ status: 'Expired', updated_at: new Date().toISOString() })
        .eq('id', waitlistId);

      if (updateErr) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to expire' }) };
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Marked as expired.' }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid action. Use offer, cancel, or expire.' }) };
  } catch (error) {
    console.error('Waitlist offer error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};

// Email function using Brevo
async function sendOfferEmail(entry, paymentLink, paymentAccount) {
  const apiKey = process.env.BREVO_API_KEY;
  const fromEmail = process.env.BREVO_FROM_EMAIL || 'noreply@philippineyouthforchrist.org';
  if (!apiKey) return;

  const TYPE_NAMES = { girls_dorm: "Girls' Dorm", boys_dorm: "Boys' Dorm", guest_house: 'Guest House', camping: 'Camping' };
  const typeName = TYPE_NAMES[entry.accommodation_type] || entry.accommodation_type;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#1a2332;color:#f5f5f5;border-radius:12px;overflow:hidden;">
      <img src="https://philippineyouthforchrist.org/IMG_3908.jpeg" alt="PYC 2026" style="width:100%;display:block;">
      <div style="padding:30px;">
        <h1 style="color:#d4a556;font-size:22px;">A Spot Has Opened Up!</h1>
        <p>Hi ${entry.registrant_name},</p>
        <p>Great news! A spot has become available for <strong>${typeName}</strong> at PYC 2026.</p>
        <div style="background:rgba(212,165,86,0.1);border:1px solid rgba(212,165,86,0.3);border-radius:8px;padding:15px;margin:20px 0;">
          <p style="margin:5px 0;"><strong>Accommodation:</strong> ${typeName}</p>
          <p style="margin:5px 0;"><strong>Spots:</strong> ${entry.spots_requested}</p>
          <p style="margin:5px 0;"><strong>Total Amount:</strong> ₱${parseFloat(entry.total_amount).toLocaleString()}</p>
          <p style="margin:5px 0;color:#e74c3c;"><strong>⏰ Expires in 48 hours</strong></p>
        </div>
        <p>Click the button below to complete your payment and secure your spot:</p>
        <a href="${paymentLink}" style="display:inline-block;background:#d4a556;color:#1a2332;padding:14px 30px;border-radius:8px;text-decoration:none;font-weight:700;font-size:16px;margin:10px 0;">Pay Now & Secure Your Spot</a>
        <p style="color:rgba(245,245,245,0.5);font-size:13px;margin-top:20px;">If you no longer need accommodation, you can ignore this email and the spot will be offered to the next person on the waitlist.</p>
      </div>
    </div>`;

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: { email: fromEmail, name: 'PYC 2026' },
      to: [{ email: entry.registrant_email, name: entry.registrant_name }],
      subject: `PYC 2026: A ${typeName} Spot Has Opened Up!`,
      htmlContent: html
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error('Brevo error: ' + err);
  }
}
