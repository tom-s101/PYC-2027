const { createClient } = require('@supabase/supabase-js');
const { createClient: createImageClient } = require('@supabase/supabase-js');
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
    const { firstName, lastName, email, imageBase64, fileName, transactionReference } = JSON.parse(event.body);

    if (!firstName || !lastName || !email || !imageBase64) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing required fields' })
      };
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // Find registration by name and email
    const { data: registrations, error: fetchError } = await supabase
      .from('registrations')
      .select('*')
      .ilike('first_name', firstName)
      .ilike('last_name', lastName)
      .ilike('email', email);

    if (fetchError || !registrations || registrations.length === 0) {
      console.error('Fetch error:', fetchError);
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Registration not found. Please check your name and email match your original registration.' })
      };
    }

    // Use the first matching registration
    const registration = registrations[0];

    // Check if payment is already approved
    if (registration.payment_status === 'Paid') {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Payment already approved. No resubmission needed.' })
      };
    }

    // Upload image to Supabase Storage
    const imageData = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(imageData, 'base64');
    const uniqueFileName = `${registration.id}-${Date.now()}-${fileName}`;
    
    const imageClient = createImageClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const { data: uploadData, error: uploadError } = await imageClient
      .storage
      .from('payment-proofs')
      .upload(uniqueFileName, buffer, {
        contentType: 'image/jpeg',
        cacheControl: '3600'
      });

    if (uploadError) {
      console.error('Upload error:', uploadError);
      throw new Error('Failed to upload image: ' + uploadError.message);
    }

    // Get public URL
    const { data: urlData } = imageClient
      .storage
      .from('payment-proofs')
      .getPublicUrl(uniqueFileName);

    // Update registration with new payment proof
    const updateData = {
      payment_proof_url: urlData.publicUrl,
      payment_status: 'Resubmitted',
      transaction_reference: transactionReference || null
    };

    if (registration.group_id) {
      // Update ALL group members
      const { error: updateError } = await supabase
        .from('registrations')
        .update(updateData)
        .eq('group_id', registration.group_id);

      if (updateError) {
        console.error('Update error:', updateError);
        throw new Error('Failed to update registration: ' + updateError.message);
      }
    } else {
      const { error: updateError } = await supabase
        .from('registrations')
        .update(updateData)
        .eq('id', registration.id);

      if (updateError) {
        console.error('Update error:', updateError);
        throw new Error('Failed to update registration: ' + updateError.message);
      }
    }

    // Ensure confirmation_number exists before emailing
    if (!registration.confirmation_number) {
      try {
        const { data: allNums } = await supabase.from('registrations').select('confirmation_number').not('confirmation_number', 'is', null);
        let nextNum = 1;
        if (allNums) { allNums.forEach(r => { const p = parseInt((r.confirmation_number||'').replace('PYC-',''),10); if (!isNaN(p) && p >= nextNum) nextNum = p + 1; }); }
        registration.confirmation_number = 'PYC-' + String(nextNum).padStart(4, '0');
        await supabase.from('registrations').update({ confirmation_number: registration.confirmation_number }).eq('id', registration.id);
      } catch (e) { console.error('Conf num gen error:', e.message); }
    }

    // Send resubmission confirmation email
    try {
      await sendResubmissionEmail(registration);
    } catch (emailError) {
      console.error('Email error:', emailError);
      // Don't fail resubmission if email fails
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: 'Payment proof resubmitted successfully! We will review it shortly.',
        registrationId: registration.id
      })
    };

  } catch (error) {
    console.error('Resubmit payment error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Failed to resubmit payment',
        message: error.message
      })
    };
  }
};

async function sendResubmissionEmail(registration) {
  const defaultClient = SibApiV3Sdk.ApiClient.instance;
  const apiKey = defaultClient.authentications['api-key'];
  apiKey.apiKey = process.env.BREVO_API_KEY;
  
  const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

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
    }
    .header {
      background: linear-gradient(135deg, #1a2332 0%, #2a3f5f 100%);
      color: #d4a556;
      padding: 20px;
      text-align: center;
    }
    .header p {
      margin: 10px 0 0;
      color: #f5f5f5 !important;
      font-size: 16px;
    }
    .content {
      padding: 40px 30px;
    }
    .info-badge {
      background: #3498db;
      color: white;
      padding: 10px 20px;
      border-radius: 20px;
      display: inline-block;
      margin: 20px 0;
      font-weight: 600;
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
    }
  </style>
</head>
<body>
  <div class="container">
    <img src="https://philippineyouthforchrist.org/IMG_3908.jpeg" alt="PYC 2026" class="banner-image">
    <div class="header">
      <p style="color: #f5f5f5 !important;">June 3-7 • Mountain View College, Mindanao</p>
    </div>
    
    <div class="content">
      <h2>📋 Payment Resubmitted</h2>
      
      <div class="info-badge">Under Review</div>
      
      <p>Dear ${registration.first_name} ${registration.last_name},</p>
      
      <p>Thank you for resubmitting your payment proof for Philippine Youth for Christ 2026.</p>
      
      <p>We have received your new payment screenshot and our team will review it shortly. You will receive a confirmation email once your payment has been verified and approved.</p>
      
      <p style="margin-top: 30px;"><strong>Your confirmation number:</strong> ${registration.confirmation_number || registration.id}</p>
      
      <p style="margin-top: 20px; color: #666;">
        We appreciate your patience and look forward to seeing you at the conference!
      </p>
    </div>

    <div class="footer">
      <p><strong>Philippine Youth for Christ</strong></p>
      <p style="color: #999 !important;">June 3-7 | Mountain View College, Mindanao, Philippines</p>
      <div class="social-links">
        <a href="https://www.facebook.com/share/1D9PJw6wkq/?mibextid=wwXIfr">Facebook</a> |
        <a href="https://www.instagram.com/philippineyouthforchrist?igsh=c2Q0MjAwbWh1cXZ2">Instagram</a>
      </div>
      <p style="font-size: 12px; color: #999 !important; margin-top: 20px;">
        For questions or concerns, contact us through social media
      </p>
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
  
  sendSmtpEmail.subject = `Payment Resubmitted - Under Review (${registration.confirmation_number || registration.id})`;
  sendSmtpEmail.htmlContent = emailHtml;

  await apiInstance.sendTransacEmail(sendSmtpEmail);
}
