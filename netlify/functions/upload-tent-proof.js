const { createClient } = require('@supabase/supabase-js');
const SibApiV3Sdk = require('sib-api-v3-sdk');

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

function buildEmailHtml(innerContent, subtitle) {
  return '<!DOCTYPE html><html><head><style>' +
    'body{font-family:"Segoe UI",Tahoma,Geneva,Verdana,sans-serif;background-color:#f5f5f5;margin:0;padding:0;}' +
    '.container{max-width:600px;margin:40px auto;background:white;border-radius:10px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.1);}' +
    '.info-box{background:#f8f9fa;border-left:4px solid #d4a556;padding:20px;margin:20px 0;border-radius:4px;}' +
    '.info-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #e0e0e0;font-size:14px;}' +
    '.info-row:last-child{border-bottom:none;}' +
    '.info-label{font-weight:600;color:#1a2332;}' +
    '.info-value{color:#555;}' +
    '.total-bar{background:#d4a556;color:white;padding:15px 20px;margin:20px 0;border-radius:8px;display:flex;justify-content:space-between;font-size:18px;font-weight:bold;}' +
    '</style></head><body><div class="container">' +
    '<img src="https://philippineyouthforchrist.org/IMG_3908.jpeg" alt="PYC 2026" style="width:100%;display:block;border-radius:10px 10px 0 0;">' +
    '<div style="background:linear-gradient(135deg,#1a2332 0%,#2a3f5f 100%);color:#d4a556;padding:20px;text-align:center;">' +
      '<h1 style="margin:0;font-size:28px;letter-spacing:2px;">PYC 2026</h1>' +
      '<p style="color:#f5f5f5;margin:5px 0 0;">' + (subtitle || 'Tenting Reservation') + '</p>' +
    '</div>' +
    '<div style="padding:40px 30px;">' + innerContent + '</div>' +
    '<div style="background:#f8f9fa;padding:20px;text-align:center;color:#666;font-size:14px;">' +
      '<p><strong>Philippine Youth for Christ</strong></p>' +
      '<p style="color:#999;">June 3-7 | Mountain View College, Mindanao</p>' +
    '</div></div></body></html>';
}

async function sendTentPendingEmail(reservations, registrantName, registrantEmail, grandTotal, paymentMethod) {
  try {
    const defaultClient = SibApiV3Sdk.ApiClient.instance;
    const apiKey = defaultClient.authentications['api-key'];
    apiKey.apiKey = process.env.BREVO_API_KEY;
    const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

    const tentLines = reservations.map(function(r) {
      var names = (r.members || []).map(function(m){return m.name + ' (' + (m.pycNumber || '') + ')';}).join(', ');
      return '<div style="padding:6px 0;font-size:13px;color:#555;">' + r.tent_size + '-person tent (Canopy ' + r.canopy_number + '): ' + names + '</div>';
    }).join('');

    const totalPeople = reservations.reduce(function(s,r){return s + ((r.members||[]).length);}, 0);

    const inner = '<h2 style="color:#1a2332;">&#128203; Tenting Reservation Under Review</h2>' +
      '<p>Dear ' + registrantName + ',</p>' +
      '<p>Thank you for reserving your tenting space for PYC 2026! Your payment proof has been received and is being reviewed by our team.</p>' +
      '<div class="info-box">' +
        '<div class="info-row"><span class="info-label">Accommodation</span><span class="info-value">Tenting</span></div>' +
        '<div class="info-row"><span class="info-label">Tents Reserved</span><span class="info-value">' + reservations.length + '</span></div>' +
        '<div class="info-row"><span class="info-label">Total People</span><span class="info-value">' + totalPeople + '</span></div>' +
        '<div class="info-row"><span class="info-label">Price per Person</span><span class="info-value">\u20B1150.00</span></div>' +
        '<div class="info-row"><span class="info-label">Payment Method</span><span class="info-value">' + (paymentMethod || 'GCash') + '</span></div>' +
      '</div>' +
      '<div style="background:#f8f9fa;padding:12px 16px;border-radius:6px;margin:15px 0;">' + tentLines + '</div>' +
      '<div class="total-bar"><span>Total Amount</span><span>\u20B1' + parseFloat(grandTotal).toLocaleString(undefined,{minimumFractionDigits:2}) + '</span></div>' +
      '<p style="color:#666;font-size:14px;margin-top:20px;">You will receive another email once your payment has been verified. Please keep this email for your records.</p>';

    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.sender = { name: 'Philippine Youth for Christ', email: process.env.BREVO_FROM_EMAIL || 'noreply@philippineyouthforchrist.org' };
    sendSmtpEmail.to = [{ email: registrantEmail, name: registrantName }];
    sendSmtpEmail.subject = 'Tenting Payment Under Review - PYC 2026';
    sendSmtpEmail.htmlContent = buildEmailHtml(inner, 'Tenting Reservation');
    await apiInstance.sendTransacEmail(sendSmtpEmail);
  } catch (e) {
    console.error('Tent pending email error:', e.message);
  }
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

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

    const { groupId, imageBase64, fileName, paymentMethod, paymentAccount, transactionReference } = parsed;

    if (!groupId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Group ID required' }) };
    }
    if (!imageBase64) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Image required' }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Load all tent reservations in this group
    const { data: reservations, error: fetchErr } = await supabase
      .from('tent_reservations')
      .select('*')
      .eq('group_id', groupId);

    if (fetchErr || !reservations || reservations.length === 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'No reservations found for this group' }) };
    }

    // Validate file
    const buffer = Buffer.from(imageBase64, 'base64');
    if (buffer.length > MAX_FILE_SIZE) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'File too large. Max 5MB.' }) };
    }
    const fileExtension = (fileName || 'jpg').split('.').pop().toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(fileExtension)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid file type. JPG, PNG, or WebP only.' }) };
    }

    // Upload to Supabase storage (same bucket as dorm, with "tent-" prefix in path)
    const storagePath = 'tent-' + groupId + '.' + fileExtension;
    const { error: uploadErr } = await supabase
      .storage
      .from('payment-proofs')
      .upload(storagePath, buffer, {
        contentType: 'image/' + fileExtension,
        upsert: true
      });

    if (uploadErr) {
      console.error('Tent proof upload error:', uploadErr.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to upload proof: ' + uploadErr.message }) };
    }

    const { data: urlData } = supabase.storage.from('payment-proofs').getPublicUrl(storagePath);
    const publicUrl = urlData.publicUrl;

    // Update all tent reservations in this group
    const grandTotal = reservations.reduce(function(s,r){return s + (parseFloat(r.total_amount) || 0);}, 0);

    // Detect resubmission — if any reservation was Rejected or already Resubmitted, this is a resubmission
    const isResubmission = reservations.some(function(r) {
      return r.payment_status === 'Rejected' || r.payment_status === 'Resubmitted';
    });
    const newStatus = isResubmission ? 'Resubmitted' : 'Pending Review';

    const { error: updateErr } = await supabase
      .from('tent_reservations')
      .update({
        payment_proof_url: publicUrl,
        payment_proof_uploaded_at: new Date().toISOString(),
        payment_status: newStatus,
        payment_method: paymentMethod || 'GCash',
        payment_account: paymentAccount || null,
        transaction_reference: transactionReference || null
      })
      .eq('group_id', groupId);

    if (updateErr) {
      console.error('Tent reservation update error:', updateErr.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to update reservations' }) };
    }

    // Send pending-review email
    const firstRes = reservations[0];
    await sendTentPendingEmail(reservations, firstRes.registrant_name, firstRes.registrant_email, grandTotal, paymentMethod);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: isResubmission ? 'Payment proof resubmitted. Under review again.' : 'Payment proof uploaded. Your tenting reservation is under review.',
        isResubmission: isResubmission,
        imageUrl: publicUrl,
        grandTotal: grandTotal
      })
    };
  } catch (err) {
    console.error('Upload tent proof error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error: ' + err.message }) };
  }
};
