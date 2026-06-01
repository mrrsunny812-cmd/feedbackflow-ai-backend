const nodemailer = require('nodemailer');

function createTransporter() {
  if (!process.env.MAIL_HOST || !process.env.MAIL_USER) {
    console.warn('⚠️  MAIL_HOST or MAIL_USER not configured in .env — emails disabled');
    return null;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.MAIL_HOST,
    port: Number(process.env.MAIL_PORT) || 587,
    secure: process.env.MAIL_SECURE === 'true',
    auth: {
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_PASS
    }
  });

  console.log(`✅ Mailer configured for ${process.env.MAIL_USER}`);
  return transporter;
}

async function sendMail({ to, subject, text, html }) {
  const transporter = createTransporter();
  if (!transporter) return false;

  try {
    const from = process.env.MAIL_FROM || process.env.MAIL_USER;
    const result = await transporter.sendMail({ from, to, subject, text, html });
    console.log(`📧 Email sent to ${to}: ${result.messageId}`);
    return true;
  } catch (err) {
    console.error(`❌ Error sending email to ${to}:`, err.message);
    throw err;
  }
}

module.exports = { sendMail };
