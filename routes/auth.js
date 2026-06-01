const express = require('express');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const WorkspaceMember = require('../models/WorkspaceMember');
const { protect, signToken } = require('../middleware/auth');
const { getWorkspaceContext } = require('../utils/permissions');
const crypto = require('crypto');
const { sendMail } = require('../services/mailer');

const router = express.Router();

const activatePendingInvites = async (user) => {
  await WorkspaceMember.updateMany(
    { email: user.email, userId: null },
    {
      $set: {
        userId: user._id,
        name: user.name,
        status: 'active',
        joinedAt: new Date()
      }
    }
  );
};

const serializeUser = async (user) => {
  const workspace = await getWorkspaceContext(user);
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    plan: user.plan,
    avatar: user.avatar,
    preferences: user.preferences,
    workspace: {
      id: workspace.workspaceId,
      memberId: workspace.member._id,
      role: workspace.role,
      permissions: workspace.permissions
    },
    usage: {
      feedbackCount: user.usage.feedbackCount,
      limit: user.getUsageLimit(),
      resetDate: user.usage.resetDate
    }
  };
};

const sendTokenResponse = async (user, statusCode, res) => {
  const token = signToken(user._id);
  res.status(statusCode).json({
    token,
    user: await serializeUser(user)
  });
};

// POST /api/auth/signup
router.post('/signup', [
  body('name').trim().isLength({ min: 2, max: 50 }).withMessage('Name must be 2-50 characters'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/).withMessage('Password must contain uppercase, lowercase, and number')
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { name, email, password } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const user = await User.create({ name, email, password });
    await activatePendingInvites(user);
    await sendTokenResponse(user, 201, res);
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login
router.post('/login', [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').notEmpty().withMessage('Password is required')
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { email, password } = req.body;

    const user = await User.findOne({ email }).select('+password');
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    user.lastLoginAt = new Date();
    await user.save({ validateBeforeSave: false });
    await activatePendingInvites(user);

    await sendTokenResponse(user, 200, res);
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me
router.get('/me', protect, async (req, res, next) => {
  try {
    const user = req.user;
    user.checkAndResetUsage();
    await user.save({ validateBeforeSave: false });

    await activatePendingInvites(user);
    res.json({ user: await serializeUser(user) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/auth/update-profile
router.patch('/update-profile', protect, [
  body('name').optional().trim().isLength({ min: 2, max: 50 }),
  body('email').optional().isEmail().normalizeEmail()
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { name, email, preferences } = req.body;
    const user = req.user;

    if (name) user.name = name;
    if (email && email !== user.email) {
      const existing = await User.findOne({ email });
      if (existing) return res.status(409).json({ error: 'Email already in use.' });
      user.email = email;
    }
    if (preferences) {
      user.preferences = { ...user.preferences, ...preferences };
    }

    await user.save({ validateBeforeSave: false });

    res.json({
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        plan: user.plan,
        avatar: user.avatar,
        preferences: user.preferences
      }
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/auth/change-password
router.patch('/change-password', protect, [
  body('currentPassword').notEmpty().withMessage('Current password required'),
  body('newPassword').isLength({ min: 8 }).withMessage('New password must be at least 8 characters')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/).withMessage('Password must contain uppercase, lowercase, and number')
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const user = await User.findById(req.user._id).select('+password');
    const { currentPassword, newPassword } = req.body;

    if (!(await user.comparePassword(currentPassword))) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    user.password = newPassword;
    await user.save();

    res.json({ message: 'Password updated successfully.' });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required')
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { email } = req.body;
    const user = await User.findOne({ email });
    if (!user) {
      // To avoid enumerating accounts, respond with success
      return res.json({ message: 'If that email exists, a reset link has been sent.' });
    }

    const resetToken = user.createPasswordResetToken();
    await user.save({ validateBeforeSave: false });

    const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/reset-password?token=${resetToken}&email=${encodeURIComponent(user.email)}`;

    // Attempt to email the reset link if mailer is configured
    const html = `<p>We've received a request to reset your FeedbackFlow password.</p><p><a href="${resetUrl}">Click here to reset your password</a></p><p>If you didn't request this, you can safely ignore this email.</p>`;

    let sent = false;
    try {
      sent = await sendMail({ to: user.email, subject: 'Reset your FeedbackFlow password', text: `Reset link: ${resetUrl}`, html });
    } catch (err) {
      console.error('Error sending reset email:', err);
      sent = false;
    }

    // For security don't reveal account existence. Return resetUrl only in non-production or when mailer not configured (developer convenience).
    const response = { message: 'If that email exists, a reset link has been sent.' };
    if (!sent || process.env.NODE_ENV !== 'production') response.resetUrl = resetUrl;

    console.log(`Password reset requested for ${user.email}; emailSent=${sent}`);
    res.json(response);
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('token').notEmpty().withMessage('Token required'),
  body('newPassword').isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/).withMessage('Password must contain uppercase, lowercase, and number')
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { email, token, newPassword } = req.body;
    const hashed = crypto.createHash('sha256').update(token).digest('hex');

    const user = await User.findOne({
      email,
      resetPasswordToken: hashed,
      resetPasswordExpires: { $gt: Date.now() }
    }).select('+password');

    if (!user) {
      return res.status(400).json({ error: 'Token is invalid or has expired.' });
    }

    user.password = newPassword;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    await sendTokenResponse(user, 200, res);
  } catch (err) {
    next(err);
  }
});

// DEV: send a test email to verify SMTP settings
router.post('/send-test-email', async (req, res, next) => {
  try {
    const to = req.body?.to || process.env.MAIL_USER || req.body?.email;
    if (!to) return res.status(400).json({ error: 'No recipient provided' });

    const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}`;
    const html = `<p>This is a test email from FeedbackFlow.</p><p>Visit: <a href="${resetUrl}">${resetUrl}</a></p>`;

    let sent = false;
    try {
      sent = await sendMail({ to, subject: 'FeedbackFlow test email', text: `Visit: ${resetUrl}`, html });
    } catch (err) {
      console.error('Error sending test email:', err);
      sent = false;
    }

    res.json({ sent, to, message: sent ? 'Email sent' : 'Mailer not configured or failed' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

module.exports = router;
