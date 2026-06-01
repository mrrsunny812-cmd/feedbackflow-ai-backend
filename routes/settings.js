const express = require('express');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const { protect } = require('../middleware/auth');

const router = express.Router();

// GET /api/settings
router.get('/', protect, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('+geminiApiKey');
    res.json({
      settings: {
        hasCustomGeminiKey: !!user.geminiApiKey,
        geminiKeyPreview: user.geminiApiKey
          ? `${user.geminiApiKey.substring(0, 8)}...${user.geminiApiKey.slice(-4)}`
          : null,
        preferences: user.preferences,
        plan: user.plan
      }
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/settings/gemini-key
router.patch('/gemini-key', protect, [
  body('apiKey').optional({ nullable: true }).trim()
], async (req, res, next) => {
  try {
    const { apiKey } = req.body;
    const user = await User.findById(req.user._id);

    if (apiKey === null || apiKey === '') {
      user.geminiApiKey = null;
    } else if (apiKey) {
      // Basic validation - Gemini keys start with "AI"
      if (!apiKey.startsWith('AI') || apiKey.length < 20) {
        return res.status(400).json({ error: 'Invalid Gemini API key format.' });
      }
      user.geminiApiKey = apiKey;
    }

    await user.save({ validateBeforeSave: false });
    res.json({ message: apiKey ? 'API key saved.' : 'API key removed.' });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/settings/preferences
router.patch('/preferences', protect, [
  body('theme').optional().isIn(['light', 'dark', 'system']),
  body('defaultView').optional().isIn(['kanban', 'list'])
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const user = req.user;
    const { theme, defaultView } = req.body;

    if (theme) user.preferences.theme = theme;
    if (defaultView) user.preferences.defaultView = defaultView;

    await user.save({ validateBeforeSave: false });
    res.json({ preferences: user.preferences });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
