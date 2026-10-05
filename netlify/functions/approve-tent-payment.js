const { createClient } = require('@supabase/supabase-js');
const SibApiV3Sdk = require('sib-api-v3-sdk');

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
    '<img src="https://philippineyouthforchrist.org/img/worship.jpg" alt="PYC 2027" style="width:100%;display:block;border-radius:10px 10px 0 0;">' +
    '<div style="background:linear-gradient(135deg,#1a2332 0%,#2a3f5f 100%);color:#d4a556;padding:20px;text-align:center;">' +
      '<h1 style="margin:0;font-size:28px;letter-spacing:2px;">PYC 2027</h1>' +
      '<p style="color:#f5f5f5;margin:5px 0 0;">' + (subtitle || 'Tenting Reservation') + '</p>' +
    '</div>' +
    '<div style="padding:40px 30px;">' + innerContent + '</div>' +
    '<div style="background:#f8f9fa;padding:20px;text-align:center;color:#666;font-size:14px;">' +
      '<p><strong>Philippine Youth for Christ</strong></p>' +
      '<p style="color:#999;">June 2-6 | SMX Convention Center Davao, Mindanao</p>' +
    '</div></div></body></html>';
}

async function sendEmail(toEmail, toName, subject, innerHtml, subtitle) {
  try {
    const defaultClient = SibApiV3Sdk.ApiClient.instance;
    const apiKey = defaultClient.authentications['api-key'];
    apiKey.apiKey = process.env.BREVO_API_KEY;
    const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.sender = { name: 'Philippine Youth for Christ', email: process.env.BREVO_FROM_EMAIL || 'noreply@philippineyouthforchrist.org' };
    sendSmtpEmail.to = [{ email: toEmail, name: toName }];
    sendSmtpEmail.subject = subject;
    sendSmtpEmail.htmlContent = buildEmailHtml(innerHtml, subtitle);
    await apiInstance.sendTransacEmail(sendSmtpEmail);
  } catch (e) {
    console.error('Tent email error:', e.message);
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
    const { groupId, reservationId, approve } = JSON.parse(event.body);

    if (!groupId && !reservationId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'groupId or reservationId required' }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Load reservations (by group or by single id)
    let query = supabase.from('tent_reservations').select('*');
    if (groupId) query = query.eq('group_id', groupId);
    else query = query.eq('id', reservationId);

    const { data: reservations, error: fetchErr } = await query;
    if (fetchErr || !reservations || reservations.length === 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Reservation not found' }) };
    }

    const newStatus = approve ? 'Paid' : 'Rejected';

    // Update all reservations in the group (or the single one)
    let updateQuery = supabase.from('tent_reservations').update({ payment_status: newStatus });
    if (groupId) updateQuery = updateQuery.eq('group_id', groupId);
    else updateQuery = updateQuery.eq('id', reservationId);

    const { error: updateErr } = await updateQuery;
    if (updateErr) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to update: ' + updateErr.message }) };
    }

    // Send email
    const first = reservations[0];
    const grandTotal = reservations.reduce(function(s,r){return s + (parseFloat(r.total_amount) || 0);}, 0);
    const totalPeople = reservations.reduce(function(s,r){return s + ((r.members || []).length);}, 0);
    const tentLines = reservations.map(function(r) {
      var names = (r.members || []).map(function(m){return m.name + ' (' + (m.pycNumber || '') + ')';}).join(', ');
      return '<div style="padding:6px 0;font-size:13px;color:#555;">' + r.tent_size + '-person tent (Canopy ' + r.canopy_number + '): ' + names + '</div>';
    }).join('');

    if (approve) {
      const inner = '<h2 style="color:#1a2332;">&#9989; Tenting Payment Confirmed!</h2>' +
        '<p>Dear ' + first.registrant_name + ',</p>' +
        '<p>Great news! Your tenting payment has been verified and your reservation is confirmed for PYC 2027.</p>' +
        '<div class="info-box">' +
          '<div class="info-row"><span class="info-label">Accommodation</span><span class="info-value">Tenting</span></div>' +
          '<div class="info-row"><span class="info-label">Tents Reserved</span><span class="info-value">' + reservations.length + '</span></div>' +
          '<div class="info-row"><span class="info-label">Total People</span><span class="info-value">' + totalPeople + '</span></div>' +
          '<div class="info-row"><span class="info-label">Payment Method</span><span class="info-value">' + (first.payment_method || 'GCash') + '</span></div>' +
        '</div>' +
        '<div style="background:#f8f9fa;padding:12px 16px;border-radius:6px;margin:15px 0;">' + tentLines + '</div>' +
        '<div class="total-bar"><span>Total Paid</span><span>\u20B1' + parseFloat(grandTotal).toLocaleString(undefined,{minimumFractionDigits:2}) + '</span></div>' +
        '<p style="color:#666;font-size:14px;margin-top:20px;">Please bring your own tent. Each tenting space is 2m&times;2m under a shared canopy. See you at PYC 2027!</p>';
      await sendEmail(first.registrant_email, first.registrant_name, 'Tenting Payment Confirmed - PYC 2027', inner, 'Tenting Reservation');
    } else {
      const inner = '<h2 style="color:#1a2332;">&#10060; Tenting Payment Needs Attention</h2>' +
        '<p>Dear ' + first.registrant_name + ',</p>' +
        '<p>We were unable to verify your recent tenting payment proof. This could be due to an unclear screenshot, wrong amount, or a missing transaction reference.</p>' +
        '<p>Please reply to this email or contact us so we can help sort this out.</p>' +
        '<div class="info-box">' +
          '<div class="info-row"><span class="info-label">Accommodation</span><span class="info-value">Tenting</span></div>' +
          '<div class="info-row"><span class="info-label">Tents Reserved</span><span class="info-value">' + reservations.length + '</span></div>' +
          '<div class="info-row"><span class="info-label">Expected Amount</span><span class="info-value">\u20B1' + parseFloat(grandTotal).toLocaleString(undefined,{minimumFractionDigits:2}) + '</span></div>' +
        '</div>';
      await sendEmail(first.registrant_email, first.registrant_name, 'Tenting Payment - Action Needed - PYC 2027', inner, 'Tenting Reservation');
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, message: approve ? 'Approved' : 'Rejected', status: newStatus })
    };
  } catch (err) {
    console.error('Approve tent payment error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
