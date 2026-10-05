const { createClient } = require('@supabase/supabase-js');
const { sendConfirmationEmail } = require('./email-helper');

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { registrationId, imageBase64, fileName, paymentMethod, paymentAccount, transactionReference } = JSON.parse(event.body);
    
    if (!registrationId || !imageBase64) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Get registration to check for group
    const { data: record, error: fetchError } = await supabase
      .from('registrations')
      .select('*')
      .eq('id', registrationId)
      .single();

    if (fetchError || !record) {
      throw new Error('Registration not found');
    }

    // Process image
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    
    // Determine file extension
    const ext = fileName ? fileName.split('.').pop().toLowerCase() : 'jpg';
    const storagePath = `payment-proofs/${registrationId}.${ext}`;

    // Upload to Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from('payment-proofs')
      .upload(storagePath, buffer, {
        contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
        upsert: true
      });

    if (uploadError) {
      console.error('Upload error:', uploadError);
      throw new Error('Failed to upload: ' + uploadError.message);
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from('payment-proofs')
      .getPublicUrl(storagePath);

    const publicUrl = urlData.publicUrl;

    // Update registration(s) with proof URL
    const updateData = {
      payment_proof_url: publicUrl,
      payment_proof_uploaded_at: new Date().toISOString(),
      payment_status: 'Pending Review'
    };
    
    // Store which payment method and account was used
    if (paymentMethod) updateData.payment_method = paymentMethod;
    if (paymentAccount) updateData.payment_account = paymentAccount;
    if (transactionReference) updateData.transaction_reference = transactionReference;

    if (record.group_id) {
      // Update all group members
      const { error: updateError } = await supabase
        .from('registrations')
        .update(updateData)
        .eq('group_id', record.group_id);

      if (updateError) throw new Error('Failed to update: ' + updateError.message);
    } else {
      const { error: updateError } = await supabase
        .from('registrations')
        .update(updateData)
        .eq('id', registrationId);

      if (updateError) throw new Error('Failed to update: ' + updateError.message);
    }

    // Re-fetch record to get confirmation_number
    const { data: freshRecord } = await supabase
      .from('registrations')
      .select('*')
      .eq('id', registrationId)
      .single();

    const emailRecord = freshRecord || record;

    // Generate PYC confirmation numbers for this registrant AND all group members
    // Numbers are assigned at payment upload, not at registration
    try {
      const { data: allNums } = await supabase.from('registrations').select('confirmation_number').not('confirmation_number', 'is', null);
      const usedNumbers = new Set();
      let nextNum = 1;
      if (allNums) {
        allNums.forEach(r => {
          if (r.confirmation_number) {
            usedNumbers.add(r.confirmation_number);
            const p = parseInt(r.confirmation_number.replace('PYC-',''), 10);
            if (!isNaN(p) && p >= nextNum) nextNum = p + 1;
          }
        });
      }

      if (emailRecord.group_id) {
        // Group: assign to ALL members who don't have a number yet
        const { data: groupMembers } = await supabase
          .from('registrations')
          .select('id, confirmation_number')
          .eq('group_id', emailRecord.group_id)
          .order('is_primary', { ascending: false });

        if (groupMembers) {
          for (const member of groupMembers) {
            if (!member.confirmation_number) {
              while (usedNumbers.has('PYC-' + String(nextNum).padStart(4, '0'))) { nextNum++; }
              const confNum = 'PYC-' + String(nextNum).padStart(4, '0');
              await supabase.from('registrations').update({ confirmation_number: confNum }).eq('id', member.id);
              usedNumbers.add(confNum);
              if (member.id === emailRecord.id) emailRecord.confirmation_number = confNum;
              console.log('Assigned', confNum, 'to', member.id);
              nextNum++;
            } else if (member.id === emailRecord.id) {
              emailRecord.confirmation_number = member.confirmation_number;
            }
          }
        }
      } else {
        // Individual: assign to this record only
        if (!emailRecord.confirmation_number) {
          while (usedNumbers.has('PYC-' + String(nextNum).padStart(4, '0'))) { nextNum++; }
          const confNum = 'PYC-' + String(nextNum).padStart(4, '0');
          await supabase.from('registrations').update({ confirmation_number: confNum }).eq('id', emailRecord.id);
          emailRecord.confirmation_number = confNum;
          console.log('Assigned', confNum, 'to', emailRecord.id);
        }
      }
    } catch (e) { console.error('Conf num generation error:', e.message); }

    // For groups, pre-fetch all members so the email can show correct group total
    if (emailRecord.group_id && emailRecord.registration_type === 'group') {
      try {
        const { data: allMembers } = await supabase
          .from('registrations')
          .select('*')
          .eq('group_id', emailRecord.group_id)
          .order('is_primary', { ascending: false });
        if (allMembers && allMembers.length > 0) {
          emailRecord._groupMembers = allMembers;
          emailRecord._groupTotal = allMembers.reduce((sum, m) => sum + (m.total_amount || 0), 0);
        }
      } catch (e) { console.error('Group prefetch error:', e.message); }
    }

    // Send email
    try {
      await sendConfirmationEmail(emailRecord, paymentMethod || 'GCash');
    } catch (emailError) {
      console.error('Email error (non-fatal):', emailError.message);
    }

    // Send Telegram notification
    try {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (botToken && chatId) {
        const method = paymentMethod || 'GCash';
        const primaryName = `${record.first_name} ${record.last_name}`;
        const primaryConf = emailRecord.confirmation_number || record.confirmation_number || '?';
        let msg;

        if (record.group_id) {
          // Group registration - fetch all members to get conf number range
          const { data: groupMembers } = await supabase
            .from('registrations')
            .select('confirmation_number, first_name, last_name')
            .eq('group_id', record.group_id)
            .order('confirmation_number', { ascending: true });
          
          if (groupMembers && groupMembers.length > 1) {
            const confNums = groupMembers.map(m => m.confirmation_number).filter(Boolean);
            const first = confNums[0] || '?';
            const last = confNums[confNums.length - 1] || '?';
            msg = `💳 ${first}–${last} Group ${primaryName} (${groupMembers.length} members) submitted ${method} payment proof`;
          } else {
            msg = `💳 ${primaryConf} ${primaryName} submitted ${method} payment proof`;
          }
        } else {
          msg = `💳 ${primaryConf} ${primaryName} submitted ${method} payment proof`;
        }

        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: msg })
        }).catch(e => console.error('TG error:', e.message));
      }
    } catch (tgErr) {
      console.error('TG notification error (non-fatal):', tgErr.message);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'Payment proof uploaded!', confirmationNumber: emailRecord.confirmation_number || '' })
    };

  } catch (error) {
    console.error('Upload error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
