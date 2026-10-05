exports.handler = async (event, context) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { emoji, message, name, lodging } = JSON.parse(event.body);
    if (!message || message.length < 20) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Message must be at least 20 characters' }) };
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (botToken && chatId) {
      const emojiMap = { 'terrible': '😢', 'bad': '😕', 'okay': '🙂', 'amazing': '🤩' };
      const emojiIcon = emojiMap[emoji] || '❓';
      const msg = `🐒 Monkey Resort Feedback\n${emojiIcon} Rating: ${emoji || 'none'}\nFrom: ${name || 'Unknown'}\nChose: ${lodging || 'Unknown'}\nMessage: ${message}`;

      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: msg })
      });
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  } catch (error) {
    console.error('Prank feedback error:', error);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  }
};
