const QRCode = require('qrcode');

// Returns a PNG QR code for a PYC number: /.netlify/functions/qr?c=PYC-0487
// Used by the approval email. The QR encodes the plain PYC number (trust-based
// event; no signed token). Served as a hosted image rather than an inline
// base64 data: URI because Gmail and several other mail apps block data: images.
exports.handler = async (event) => {
  const code = String((event.queryStringParameters || {}).c || '').trim().toUpperCase();
  if (!/^PYC-\d{4,5}$/.test(code)) {
    return { statusCode: 400, headers: { 'Content-Type': 'text/plain' }, body: 'Invalid code' };
  }

  try {
    const png = await QRCode.toBuffer(code, { type: 'png', width: 360, margin: 2, errorCorrectionLevel: 'M' });
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=31536000, immutable'
      },
      body: png.toString('base64'),
      isBase64Encoded: true
    };
  } catch (e) {
    console.error('QR error:', e.message);
    return { statusCode: 500, headers: { 'Content-Type': 'text/plain' }, body: 'QR error' };
  }
};
