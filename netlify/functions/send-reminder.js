const { createClient } = require('@supabase/supabase-js');
const SibApiV3Sdk = require('sib-api-v3-sdk');

exports.handler = async (event, context) => {
  // Add CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // How many to send per call. The frontend calls this repeatedly until done.
    // Kept small so each call finishes well within Netlify's function time limit.
    let batchSize = 25;
    try {
      const body = event.body ? JSON.parse(event.body) : {};
      if (body && body.batchSize && Number.isFinite(body.batchSize)) {
        batchSize = Math.min(Math.max(parseInt(body.batchSize, 10), 1), 50);
      }
    } catch (e) { /* ignore bad body, use default */ }

    // Progress totals (for the dashboard readout). These are cheap COUNT queries.
    const { count: totalPaid } = await supabase
      .from('registrations')
      .select('id', { count: 'exact', head: true })
      .eq('payment_status', 'Paid');

    const { count: alreadySent } = await supabase
      .from('registrations')
      .select('id', { count: 'exact', head: true })
      .eq('payment_status', 'Paid')
      .not('reminder_sent_at', 'is', null);

    // Pull the NEXT batch of paid registrants who have NOT yet been emailed.
    // Because we stamp reminder_sent_at after each send, re-running this skips
    // anyone already done — so a restart never double-sends.
    const { data: registrations, error: fetchError } = await supabase
      .from('registrations')
      .select('*')
      .eq('payment_status', 'Paid')
      .is('reminder_sent_at', null)
      .order('created_at', { ascending: true })
      .limit(batchSize);

    if (fetchError) {
      console.error('Fetch error:', fetchError);
      throw new Error('Failed to fetch registrations: ' + fetchError.message);
    }

    // Nothing left to send — we're done.
    if (!registrations || registrations.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          done: true,
          message: 'All reminder emails have been sent.',
          sent: 0,
          failed: 0,
          remaining: 0,
          totalPaid: totalPaid || 0,
          totalSent: alreadySent || 0
        })
      };
    }

    // Configure Brevo
    const defaultClient = SibApiV3Sdk.ApiClient.instance;
    const apiKey = defaultClient.authentications['api-key'];
    apiKey.apiKey = process.env.BREVO_API_KEY;
    const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

    let sent = 0;
    let failed = 0;
    const failedEmails = [];

    for (const registration of registrations) {
      try {
        await sendReminderEmail(apiInstance, registration);
        // Stamp as sent IMMEDIATELY so even a crash on the next email keeps this
        // person marked done (no double-send on restart).
        const { error: stampError } = await supabase
          .from('registrations')
          .update({ reminder_sent_at: new Date().toISOString() })
          .eq('id', registration.id);
        if (stampError) {
          // Email went out but we couldn't record it — log it so admin is aware.
          // We do NOT count it as failed (the email was delivered), but flag it.
          console.error('Sent but failed to stamp ' + registration.id + ':', stampError.message);
        }
        sent++;
      } catch (emailError) {
        console.error(`Failed to send to ${registration.email}:`, emailError);
        failed++;
        failedEmails.push(registration.email);
      }
    }

    // How many paid people still have no reminder after this batch?
    const { count: remainingCount } = await supabase
      .from('registrations')
      .select('id', { count: 'exact', head: true })
      .eq('payment_status', 'Paid')
      .is('reminder_sent_at', null);

    const remaining = remainingCount || 0;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        done: remaining === 0,
        message: 'Batch processed.',
        sent: sent,
        failed: failed,
        failedEmails: failedEmails,
        remaining: remaining,
        totalPaid: totalPaid || 0,
        totalSent: (alreadySent || 0) + sent
      })
    };

  } catch (error) {
    console.error('Send reminder error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Failed to send reminder emails',
        message: error.message
      })
    };
  }
};

async function sendReminderEmail(apiInstance, registration) {
  const mealPlanNames = {
    'full': 'Full Meal Plan',
    'half': 'Half Meal Plan'
  };
  const mealPlanName = mealPlanNames[registration.meal_plan] || 'Full Meal Plan';

  const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background-color: #f5f5f5;
      margin: 0;
      padding: 0;
    }
    .container {
      max-width: 600px;
      margin: 40px auto;
      background: white;
      border-radius: 10px;
      overflow: hidden;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }
    .banner-image {
      width: 100%;
      display: block;
      border-radius: 10px 10px 0 0;
    }
    .header {
      background: linear-gradient(135deg, #1a2332 0%, #2a3f5f 100%);
      color: #d4a556;
      padding: 20px;
      text-align: center;
    }
    .header h1 {
      margin: 0;
      font-size: 28px;
      letter-spacing: 2px;
    }
    .header p {
      margin: 10px 0 0;
      color: #f5f5f5;
      font-size: 16px;
    }
    .content {
      padding: 40px 30px;
    }
    .content h2 {
      color: #1a2332;
      margin-bottom: 20px;
    }
    .countdown-box {
      background: linear-gradient(135deg, #d4a556 0%, #c9965d 100%);
      color: white;
      padding: 30px;
      border-radius: 10px;
      text-align: center;
      margin: 20px 0;
    }
    .countdown-box .number {
      font-size: 48px;
      font-weight: bold;
      margin: 10px 0;
    }
    .countdown-box .label {
      font-size: 18px;
      text-transform: uppercase;
      letter-spacing: 2px;
    }
    .info-box {
      background: #f8f9fa;
      border-left: 4px solid #d4a556;
      padding: 20px;
      margin: 20px 0;
      border-radius: 4px;
    }
    .info-row {
      display: flex;
      justify-content: space-between;
      padding: 10px 0;
      border-bottom: 1px solid #e0e0e0;
    }
    .info-row:last-child {
      border-bottom: none;
    }
    .info-label {
      font-weight: 600;
      color: #1a2332;
    }
    .info-value {
      color: #555;
    }
    .checklist {
      background: #fff3cd;
      border-left: 4px solid #f39c12;
      padding: 20px;
      margin: 20px 0;
      border-radius: 4px;
    }
    .checklist h3 {
      color: #1a2332;
      margin-top: 0;
      margin-bottom: 15px;
    }
    .checklist ul {
      margin: 10px 0;
      padding-left: 20px;
    }
    .checklist li {
      margin: 8px 0;
      color: #555;
    }
    .footer {
      background: #f8f9fa;
      padding: 20px;
      text-align: center;
      color: #666;
      font-size: 14px;
    }
    .social-links {
      margin: 15px 0;
    }
    .social-links a {
      color: #d4a556;
      text-decoration: none;
      margin: 0 10px;
      display: inline-block;
    }
  </style>
</head>
<body>
  <div class="container">
    <img src="https://philippineyouthforchrist.org/IMG_3908.jpeg" alt="PYC 2026 - Above and Beyond" class="banner-image">
    <div class="header">
      <h1>PYC 2026 REMINDER</h1>
      <p>June 3-7 • Mountain View College, Valencia, Bukidnon</p>
    </div>
    
    <div class="content">
      <h2>PYC 2026 is Almost Here</h2>
      
      <div class="countdown-box">
        <div class="label">PYC 2026 Begins June 3 — In</div>
        <div class="number">10</div>
        <div class="label">Days</div>
      </div>
      
      <p>Dear ${registration.first_name} ${registration.last_name},</p>
      <p>Philippine Youth for Christ 2026 begins on <strong>June 3</strong>, just <strong>10 days</strong> from now. We are looking forward to welcoming you for a meaningful time of worship, fellowship, and growth. To help you prepare, please review the details and checklist below.</p>
      
      <div class="info-box">
        <h3 style="margin-top: 0; color: #1a2332;">Your Registration Details</h3>
        <div class="info-row">
          <span class="info-label">Registration Number:</span>
          <span class="info-value">${registration.confirmation_number || registration.id}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Name:</span>
          <span class="info-value">${registration.first_name} ${registration.last_name}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Email:</span>
          <span class="info-value">${registration.email}</span>
        </div>
        <div class="info-row">
          <span class="info-label">T-Shirt Size:</span>
          <span class="info-value">${(registration.tshirt_size || 'N/A').toUpperCase()}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Meal Plan:</span>
          <span class="info-value">${mealPlanName}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Payment Status:</span>
          <span class="info-value" style="color: #27ae60; font-weight: 600;">PAID</span>
        </div>
      </div>

      <div class="checklist">
        <h3>What to Bring</h3>
        <ul>
          <li>Valid ID for check-in</li>
          <li>Bible</li>
          <li>Tumbler or reusable water bottle</li>
          <li>Your own utensils</li>
          <li>Clothes that follow the dress code</li>
          <li>Worship attire</li>
          <li>Umbrella</li>
          <li>Toiletries and personal hygiene items</li>
          <li>Pocket money</li>
        </ul>
        <p style="margin: 15px 0 0; color: #555;"><strong>Note:</strong> Those with a meal plan will be provided a plate.</p>
      </div>

      <div style="background: #fdecea; border-left: 4px solid #e74c3c; padding: 20px; margin: 20px 0; border-radius: 4px;">
        <h3 style="color: #1a2332; margin-top: 0;">Dress Code</h3>
        <p style="margin: 5px 0; color: #555;">To keep with the spirit of the conference, please <strong>avoid wearing</strong> the following:</p>
        <ul style="margin: 10px 0; padding-left: 20px; color: #555;">
          <li>Shorts</li>
          <li>Sleeveless tops</li>
          <li>Revealing clothing</li>
        </ul>
      </div>

      <div style="background: #e8f5e9; border-left: 4px solid #27ae60; padding: 20px; margin: 20px 0; border-radius: 4px;">
        <h3 style="color: #1a2332; margin-top: 0;">Event Details</h3>
        <p style="margin: 5px 0;"><strong>When:</strong> June 3-7, 2026</p>
        <p style="margin: 5px 0;"><strong>Where:</strong> Mountain View College, Valencia, Bukidnon, Philippines</p>
        <p style="margin: 5px 0;"><strong>Theme:</strong> "Above and Beyond" (Ephesians 3:20)</p>
        <p style="margin: 15px 0 5px; font-style: italic; color: #666;">
          "Now to him who is able to do immeasurably more than all we ask or imagine..."
        </p>
      </div>

      <p style="margin-top: 30px; font-size: 16px; color: #1a2332;">
        <strong>We look forward to seeing you there and worshipping together.</strong>
      </p>
      
      <p style="margin-top: 20px; color: #666; font-size: 14px;">
        Please keep this email for your records. Your registration number is: <strong>${registration.confirmation_number || registration.id}</strong>
      </p>
    </div>

    <div class="footer">
      <p><strong>Philippine Youth for Christ</strong></p>
      <p>June 3-7, 2026 | Mountain View College, Valencia, Bukidnon, Philippines</p>
      <p style="font-size: 14px; margin: 15px 0;">If you have any questions, please reach out to us through our social media accounts:</p>
      <div class="social-links">
        <a href="https://www.facebook.com/share/1D9PJw6wkq/?mibextid=wwXIfr" style="display: inline-block; margin: 5px 10px;">
          <img src="https://cdn-icons-png.flaticon.com/512/124/124010.png" alt="Facebook" style="width: 24px; height: 24px; vertical-align: middle;"> Facebook
        </a>
        <a href="https://www.instagram.com/philippineyouthforchrist?igsh=c2Q0MjAwbWh1cXZ2" style="display: inline-block; margin: 5px 10px;">
          <img src="https://cdn-icons-png.flaticon.com/512/2111/2111463.png" alt="Instagram" style="width: 24px; height: 24px; vertical-align: middle;"> Instagram
        </a>
      </div>
    </div>
  </div>
</body>
</html>
  `;

  const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
  
  sendSmtpEmail.sender = {
    name: 'Philippine Youth for Christ',
    email: 'noreply@philippineyouthforchrist.org'
  };
  
  sendSmtpEmail.to = [{
    email: registration.email,
    name: `${registration.first_name} ${registration.last_name}`
  }];
  
  sendSmtpEmail.subject = `PYC 2026 Begins in 10 Days - Registration ${registration.confirmation_number || registration.id}`;
  sendSmtpEmail.htmlContent = emailHtml;

  await apiInstance.sendTransacEmail(sendSmtpEmail);
}
