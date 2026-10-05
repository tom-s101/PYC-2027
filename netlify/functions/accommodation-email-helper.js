const SibApiV3Sdk = require('sib-api-v3-sdk');
const { createClient } = require('@supabase/supabase-js');

const TYPE_NAMES = {
  girls_dorm: 'Girls Dorm',
  boys_dorm: 'Boys Dorm',
  guest_house: 'Guest House',
  camping: 'Camping'
};

function getEmailTemplate(innerContent) {
  return `<!DOCTYPE html><html><head><style>
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f5f5f5; margin: 0; padding: 0; }
    .container { max-width: 600px; margin: 40px auto; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
    .banner-image { width: 100%; display: block; border-radius: 10px 10px 0 0; }
    .header { background: linear-gradient(135deg, #1a2332 0%, #2a3f5f 100%); color: #d4a556; padding: 20px; text-align: center; }
    .header h1 { margin: 0; font-size: 28px; letter-spacing: 2px; }
    .content { padding: 40px 30px; }
    .info-box { background: #f8f9fa; border-left: 4px solid #d4a556; padding: 20px; margin: 20px 0; border-radius: 4px; }
    .info-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #e0e0e0; font-size: 14px; }
    .info-row:last-child { border-bottom: none; }
    .info-label { font-weight: 600; color: #1a2332; }
    .info-value { color: #555; }
    .total-bar { background: #d4a556; color: white; padding: 15px 20px; margin: 20px 0; border-radius: 8px; display: flex; justify-content: space-between; font-size: 18px; font-weight: bold; }
    .btn { display: inline-block; padding: 14px 30px; background: #d4a556; color: #1a2332; text-decoration: none; border-radius: 8px; font-weight: bold; margin-top: 15px; }
    .footer { background: #f8f9fa; padding: 20px; text-align: center; color: #666; font-size: 14px; }
    .social-links a { color: #d4a556; text-decoration: none; margin: 0 10px; }
  </style></head><body>
  <div class="container">
    <img src="https://philippineyouthforchrist.org/IMG_3908.jpeg" alt="PYC 2026 - Above and Beyond" class="banner-image" style="width:100%;display:block;border-radius:10px 10px 0 0;">
    <div class="header">
      <h1>PYC 2026</h1>
      <p style="color:#f5f5f5;margin:5px 0 0;">Accommodation Reservation</p>
    </div>
    <div class="content">${innerContent}</div>
    <div class="footer">
      <p><strong>Philippine Youth for Christ</strong></p>
      <p style="color:#999;">June 3-7 | Mountain View College, Mindanao</p>
      <div class="social-links">
        <a href="https://www.facebook.com/share/1D9PJw6wkq/?mibextid=wwXIfr">Facebook</a> |
        <a href="https://www.instagram.com/philippineyouthforchrist?igsh=c2Q0MjAwbWh1cXZ2">Instagram</a>
      </div>
    </div>
  </div></body></html>`;
}

// Look up the PYC confirmation number from the registrations table
async function lookupConfirmationNumber(reservation) {
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Try by registration_id first
    if (reservation.registration_id) {
      const { data } = await supabase
        .from('registrations')
        .select('confirmation_number')
        .eq('id', reservation.registration_id)
        .single();
      if (data && data.confirmation_number) return data.confirmation_number;
    }

    // Fallback: try by email (case-insensitive — emails may be stored with mixed case)
    if (reservation.registrant_email) {
      const { data } = await supabase
        .from('registrations')
        .select('confirmation_number')
        .ilike('email', reservation.registrant_email)
        .not('confirmation_number', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      if (data && data.confirmation_number) return data.confirmation_number;
    }
  } catch (e) {
    console.error('Confirmation number lookup error:', e.message);
  }
  return null;
}

async function sendAccommodationEmail(toEmail, toName, subject, innerHtml) {
  const defaultClient = SibApiV3Sdk.ApiClient.instance;
  const apiKey = defaultClient.authentications['api-key'];
  apiKey.apiKey = process.env.BREVO_API_KEY;
  const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

  const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
  sendSmtpEmail.sender = {
    name: 'Philippine Youth for Christ',
    email: process.env.BREVO_FROM_EMAIL || 'noreply@philippineyouthforchrist.org'
  };
  sendSmtpEmail.to = [{ email: toEmail, name: toName }];
  sendSmtpEmail.subject = subject;
  sendSmtpEmail.htmlContent = getEmailTemplate(innerHtml);
  await apiInstance.sendTransacEmail(sendSmtpEmail);
}

// Email 1: Reservation pending (sent after proof upload)
async function sendPendingEmail(reservation) {
  const typeName = TYPE_NAMES[reservation.accommodation_type] || reservation.accommodation_type;
  const confNum = await lookupConfirmationNumber(reservation);
  const displayId = confNum || reservation.id.substring(0, 8);
  const innerHtml = `
    <h2 style="color:#1a2332;">&#128203; Reservation Under Review</h2>
    <p>Dear ${reservation.registrant_name},</p>
    <p>Thank you for reserving your accommodation for PYC 2026! Your payment proof has been received and is being reviewed by our team.</p>
    <div class="info-box">
      <div class="info-row"><span class="info-label">Registration Number:</span><span class="info-value">${displayId}</span></div>
      <div class="info-row"><span class="info-label">Accommodation:</span><span class="info-value">${typeName}</span></div>
      <div class="info-row"><span class="info-label">Spots Reserved:</span><span class="info-value">${reservation.spots_requested} person(s)</span></div>
      <div class="info-row"><span class="info-label">Price per Person:</span><span class="info-value">\u20B1${parseFloat(reservation.price_per_spot).toFixed(2)}</span></div>
      <div class="info-row"><span class="info-label">Payment Method:</span><span class="info-value">${reservation.payment_method || 'GCash'}</span></div>
    </div>
    <div class="total-bar"><span>Total Amount:</span><span>\u20B1${parseFloat(reservation.total_amount).toFixed(2)}</span></div>
    <p style="color:#666;font-size:14px;margin-top:20px;">You will receive another email once your payment has been verified. Please keep this email for your records.</p>
  `;
  await sendAccommodationEmail(
    reservation.registrant_email,
    reservation.registrant_name,
    `Accommodation Under Review - PYC 2026 (${displayId})`,
    innerHtml
  );
}

// Email 2: Payment approved
async function sendApprovedEmail(reservation) {
  const typeName = TYPE_NAMES[reservation.accommodation_type] || reservation.accommodation_type;
  const confNum = await lookupConfirmationNumber(reservation);
  const displayId = confNum || reservation.id.substring(0, 8);
  const innerHtml = `
    <h2 style="color:#1a2332;">&#9989; Accommodation Confirmed!</h2>
    <p>Dear ${reservation.registrant_name},</p>
    <p><strong>Great news!</strong> Your accommodation payment has been verified and your reservation is confirmed.</p>
    <div class="info-box">
      <div class="info-row"><span class="info-label">Registration Number:</span><span class="info-value">${displayId}</span></div>
      <div class="info-row"><span class="info-label">Accommodation:</span><span class="info-value">${typeName}</span></div>
      <div class="info-row"><span class="info-label">Spots Confirmed:</span><span class="info-value">${reservation.spots_requested} person(s)</span></div>
    </div>
    <div class="total-bar"><span>Amount Paid:</span><span>\u20B1${parseFloat(reservation.total_amount).toFixed(2)}</span></div>
    <p style="margin-top:20px;">You will be sharing your accommodation with other PYC 2026 delegates. Room assignments will be coordinated by the organizing team closer to the event.</p>
    <p style="color:#666;font-size:14px;margin-top:15px;">Please bring a valid ID for check-in. We look forward to seeing you at PYC 2026!</p>
  `;
  await sendAccommodationEmail(
    reservation.registrant_email,
    reservation.registrant_name,
    `Accommodation Confirmed! - PYC 2026 (${displayId})`,
    innerHtml
  );
}

// Email 3: Payment rejected (with resubmit link)
async function sendRejectedEmail(reservation) {
  const siteUrl = 'https://philippineyouthforchrist.org';
  const resubmitUrl = `${siteUrl}/resubmit-accommodation?id=${reservation.id}`;
  const typeName = TYPE_NAMES[reservation.accommodation_type] || reservation.accommodation_type;
  const confNum = await lookupConfirmationNumber(reservation);
  const displayId = confNum || reservation.id.substring(0, 8);
  const innerHtml = `
    <h2 style="color:#e74c3c;">&#10060; Payment Not Verified</h2>
    <p>Dear ${reservation.registrant_name},</p>
    <p>Unfortunately, we were unable to verify your accommodation payment. This could be due to an unclear screenshot, incorrect amount, or the payment not being received.</p>
    <div class="info-box">
      <div class="info-row"><span class="info-label">Registration Number:</span><span class="info-value">${displayId}</span></div>
      <div class="info-row"><span class="info-label">Accommodation:</span><span class="info-value">${typeName}</span></div>
      <div class="info-row"><span class="info-label">Amount Due:</span><span class="info-value">\u20B1${parseFloat(reservation.total_amount).toFixed(2)}</span></div>
    </div>
    <p style="margin-top:20px;"><strong>What to do next:</strong></p>
    <p>Please resend the correct payment and upload a new screenshot using the link below. If you do not resubmit within a reasonable time, your accommodation may be given to another person.</p>
    <p style="text-align:center;"><a href="${resubmitUrl}" class="btn">Resubmit Payment Proof</a></p>
    <p style="color:#666;font-size:14px;margin-top:20px;">If you believe this is an error, please contact us through our Facebook or Instagram pages.</p>
  `;
  await sendAccommodationEmail(
    reservation.registrant_email,
    reservation.registrant_name,
    `Action Required: Accommodation Payment Issue - PYC 2026`,
    innerHtml
  );
}

// Email 1-batch: Combined "under review" email for multiple reservations from one proof upload
async function sendPendingEmailBatch(reservations) {
  if (!reservations || reservations.length === 0) return;
  if (reservations.length === 1) return sendPendingEmail(reservations[0]);

  const primary = reservations[0];
  const confNum = await lookupConfirmationNumber(primary);
  const displayId = confNum || primary.id.substring(0, 8);
  const grandTotal = reservations.reduce(function(s,r){ return s + (parseFloat(r.total_amount) || 0); }, 0);
  const totalSpots = reservations.reduce(function(s,r){ return s + (parseInt(r.spots_requested) || 0); }, 0);

  const lines = reservations.map(function(r) {
    const t = TYPE_NAMES[r.accommodation_type] || r.accommodation_type;
    return '<div class="info-row"><span class="info-label">' + t + '</span><span class="info-value">' +
           r.spots_requested + ' person(s) &mdash; \u20B1' + parseFloat(r.total_amount).toFixed(2) + '</span></div>';
  }).join('');

  const innerHtml = `
    <h2 style="color:#1a2332;">&#128203; Reservation Under Review</h2>
    <p>Dear ${primary.registrant_name},</p>
    <p>Thank you for reserving your accommodations for PYC 2026! Your payment proof has been received and is being reviewed by our team.</p>
    <div class="info-box">
      <div class="info-row"><span class="info-label">Registration Number:</span><span class="info-value">${displayId}</span></div>
      <div class="info-row"><span class="info-label">Total Accommodations:</span><span class="info-value">${reservations.length}</span></div>
      <div class="info-row"><span class="info-label">Total Spots:</span><span class="info-value">${totalSpots} person(s)</span></div>
      <div class="info-row"><span class="info-label">Payment Method:</span><span class="info-value">${primary.payment_method || 'GCash'}</span></div>
    </div>
    <div class="info-box" style="background:#fff;border-left-color:#4a7c9e;">
      ${lines}
    </div>
    <div class="total-bar"><span>Total Amount:</span><span>\u20B1${grandTotal.toFixed(2)}</span></div>
    <p style="color:#666;font-size:14px;margin-top:20px;">You will receive another email once your payment has been verified. Please keep this email for your records.</p>
  `;
  await sendAccommodationEmail(
    primary.registrant_email,
    primary.registrant_name,
    `Accommodation Under Review - PYC 2026 (${displayId})`,
    innerHtml
  );
}

// Email 2-batch: Combined approval email for multiple reservations
async function sendApprovedEmailBatch(reservations) {
  if (!reservations || reservations.length === 0) return;
  if (reservations.length === 1) return sendApprovedEmail(reservations[0]);

  const primary = reservations[0];
  const confNum = await lookupConfirmationNumber(primary);
  const displayId = confNum || primary.id.substring(0, 8);
  const grandTotal = reservations.reduce(function(s,r){ return s + (parseFloat(r.total_amount) || 0); }, 0);
  const totalSpots = reservations.reduce(function(s,r){ return s + (parseInt(r.spots_requested) || 0); }, 0);

  const lines = reservations.map(function(r) {
    const t = TYPE_NAMES[r.accommodation_type] || r.accommodation_type;
    return '<div class="info-row"><span class="info-label">' + t + '</span><span class="info-value">' +
           r.spots_requested + ' person(s) &mdash; \u20B1' + parseFloat(r.total_amount).toFixed(2) + '</span></div>';
  }).join('');

  const innerHtml = `
    <h2 style="color:#1a2332;">&#9989; Accommodations Confirmed!</h2>
    <p>Dear ${primary.registrant_name},</p>
    <p><strong>Great news!</strong> Your accommodation payment has been verified and all your reservations are confirmed.</p>
    <div class="info-box">
      <div class="info-row"><span class="info-label">Registration Number:</span><span class="info-value">${displayId}</span></div>
      <div class="info-row"><span class="info-label">Total Accommodations:</span><span class="info-value">${reservations.length}</span></div>
      <div class="info-row"><span class="info-label">Total Spots:</span><span class="info-value">${totalSpots} person(s)</span></div>
    </div>
    <div class="info-box" style="background:#fff;border-left-color:#4a7c9e;">
      ${lines}
    </div>
    <div class="total-bar"><span>Amount Paid:</span><span>\u20B1${grandTotal.toFixed(2)}</span></div>
    <p style="margin-top:20px;">You will be sharing your accommodation with other PYC 2026 delegates. Room assignments will be coordinated by the organizing team closer to the event.</p>
    <p style="color:#666;font-size:14px;margin-top:15px;">Please bring a valid ID for check-in. We look forward to seeing you at PYC 2026!</p>
  `;
  await sendAccommodationEmail(
    primary.registrant_email,
    primary.registrant_name,
    `Accommodations Confirmed! - PYC 2026 (${displayId})`,
    innerHtml
  );
}

// Email 3-batch: Combined rejection email for multiple reservations
async function sendRejectedEmailBatch(reservations) {
  if (!reservations || reservations.length === 0) return;
  if (reservations.length === 1) return sendRejectedEmail(reservations[0]);

  const siteUrl = 'https://philippineyouthforchrist.org';
  const primary = reservations[0];
  const resubmitUrl = `${siteUrl}/resubmit-accommodation?id=${primary.id}`;
  const confNum = await lookupConfirmationNumber(primary);
  const displayId = confNum || primary.id.substring(0, 8);
  const grandTotal = reservations.reduce(function(s,r){ return s + (parseFloat(r.total_amount) || 0); }, 0);

  const lines = reservations.map(function(r) {
    const t = TYPE_NAMES[r.accommodation_type] || r.accommodation_type;
    return '<div class="info-row"><span class="info-label">' + t + '</span><span class="info-value">' +
           r.spots_requested + ' person(s) &mdash; \u20B1' + parseFloat(r.total_amount).toFixed(2) + '</span></div>';
  }).join('');

  const innerHtml = `
    <h2 style="color:#e74c3c;">&#10060; Payment Not Verified</h2>
    <p>Dear ${primary.registrant_name},</p>
    <p>Unfortunately, we were unable to verify your accommodation payment. This could be due to an unclear screenshot, incorrect amount, or the payment not being received.</p>
    <div class="info-box">
      <div class="info-row"><span class="info-label">Registration Number:</span><span class="info-value">${displayId}</span></div>
    </div>
    <div class="info-box" style="background:#fff;border-left-color:#e74c3c;">
      ${lines}
    </div>
    <div class="total-bar" style="background:#e74c3c;"><span>Total Due:</span><span>\u20B1${grandTotal.toFixed(2)}</span></div>
    <p style="margin-top:20px;"><strong>What to do next:</strong></p>
    <p>Please resend the correct payment and upload a new screenshot using the link below. If you do not resubmit within a reasonable time, your accommodations may be given to others.</p>
    <p style="text-align:center;"><a href="${resubmitUrl}" class="btn">Resubmit Payment Proof</a></p>
    <p style="color:#666;font-size:14px;margin-top:20px;">If you believe this is an error, please contact us through our Facebook or Instagram pages.</p>
  `;
  await sendAccommodationEmail(
    primary.registrant_email,
    primary.registrant_name,
    `Action Required: Accommodation Payment Issue - PYC 2026`,
    innerHtml
  );
}

module.exports = { sendPendingEmail, sendApprovedEmail, sendRejectedEmail, sendPendingEmailBatch, sendApprovedEmailBatch, sendRejectedEmailBatch };
