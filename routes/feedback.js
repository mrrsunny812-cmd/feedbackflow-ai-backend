const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { body, validationResult } = require('express-validator');
const Feedback = require('../models/Feedback');
const Task = require('../models/Task');
const { protect } = require('../middleware/auth');
const { createGeminiService } = require('../services/gemini');
const { attachWorkspace, canViewAllTasks } = require('../utils/permissions');

const router = express.Router();

const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml'];
const VISION_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/jpg'];
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.svg'];

function hasAllowedImageExtension(fileName = '') {
  const lower = fileName.toLowerCase();
  return IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

function isImageFile(file) {
  return IMAGE_MIME_TYPES.includes(file.mimetype) || hasAllowedImageExtension(file.originalname);
}

function isVisionImageFile(file) {
  const lower = (file.originalname || '').toLowerCase();
  return VISION_IMAGE_MIME_TYPES.includes(file.mimetype)
    || lower.endsWith('.png')
    || lower.endsWith('.jpg')
    || lower.endsWith('.jpeg');
}

function getSafeTaskGroupName(rawName = '', fallbackFileName = 'Upload') {
  const clean = String(rawName || '').trim().replace(/\s+/g, ' ').slice(0, 100);
  if (clean) return clean;

  const fallback = String(fallbackFileName || 'Upload')
    .replace(/\.[^.]+$/, '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 100);

  return fallback || 'Upload';
}

// Multer setup - memory storage for processing
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = ['text/plain', 'application/pdf', 'text/markdown', ...IMAGE_MIME_TYPES];
    if (
      allowed.includes(file.mimetype)
      || file.originalname.toLowerCase().endsWith('.txt')
      || file.originalname.toLowerCase().endsWith('.md')
      || hasAllowedImageExtension(file.originalname)
    ) {
      cb(null, true);
    } else {
      cb(new Error('Only .txt, .md, .pdf, .png, .jpg, .jpeg, and .svg files are allowed'), false);
    }
  }
});

// Helper to extract text from uploaded files
async function extractFileText(file) {
  if (file.mimetype === 'image/svg+xml' || file.originalname.toLowerCase().endsWith('.svg')) {
    return file.buffer.toString('utf-8');
  }

  if (file.mimetype === 'application/pdf') {
    const data = await pdfParse(file.buffer);
    return data.text;
  }

  return file.buffer.toString('utf-8');
}

// GET /api/feedback - List all feedback for user
router.get('/', protect, attachWorkspace, async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const [feedbacks, total] = await Promise.all([
      Feedback.find({ userId: req.workspace.ownerId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-aiResponse'),
      Feedback.countDocuments({ userId: req.workspace.ownerId })
    ]);

    res.json({
      feedbacks,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/feedback/text - Process text feedback
router.post('/text', protect, attachWorkspace, [
  body('content').trim().isLength({ min: 10, max: 50000 }).withMessage('Content must be 10-50000 characters')
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const user = req.user;
    if (!canViewAllTasks(req.workspace.member)) {
      return res.status(403).json({ error: 'Only admins and managers can process workspace feedback.' });
    }

    // Check usage limits
    if (!user.canProcessFeedback()) {
      return res.status(429).json({
        error: `Monthly feedback limit reached (${user.getUsageLimit()} for ${user.plan} plan). Upgrade to Pro for more.`,
        upgradeRequired: true
      });
    }

    const { content } = req.body;

    // Create feedback record
    const feedback = await Feedback.create({
      userId: req.workspace.ownerId,
      type: 'text',
      rawContent: content,
      status: 'processing'
    });

    // Process with Gemini
    try {
      const gemini = createGeminiService(user.geminiApiKey);
      const aiResult = await gemini.analyzeFeedback(content, 'text');

      // Create tasks from AI response
      const taskDocs = aiResult.tasks.map((task, index) => ({
        userId: req.workspace.ownerId,
        feedbackId: feedback._id,
        title: task.title,
        description: task.description,
        priority: task.priority,
        category: task.category,
        suggestion: task.suggestion,
        tailwindFix: task.tailwindFix,
        estimatedMinutes: task.estimatedMinutes || 30,
        status: 'Todo',
        order: index
      }));

      const createdTasks = await Task.insertMany(taskDocs);

      // Update feedback record
      feedback.status = 'completed';
      feedback.processedAt = new Date();
      feedback.aiResponse = aiResult;
      feedback.tasksGenerated = createdTasks.length;
      await feedback.save();

      // Increment user usage
      user.usage.feedbackCount += 1;
      await user.save({ validateBeforeSave: false });

      res.status(201).json({
        feedback: {
          id: feedback._id,
          status: feedback.status,
          tasksGenerated: feedback.tasksGenerated,
          summary: aiResult.summary,
          overallInsights: aiResult.overallInsights,
          quickWins: aiResult.quickWins
        },
        tasks: createdTasks
      });
    } catch (aiErr) {
      feedback.status = 'failed';
      feedback.error = aiErr.message;
      await feedback.save();
      throw aiErr;
    }
  } catch (err) {
    next(err);
  }
});

// POST /api/feedback/url - Process URL (Loom) feedback
router.post('/url', protect, attachWorkspace, [
  body('url').isURL().withMessage('Valid URL required'),
  body('additionalContext').optional().trim().isLength({ max: 5000 })
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const user = req.user;
    if (!canViewAllTasks(req.workspace.member)) {
      return res.status(403).json({ error: 'Only admins and managers can process workspace feedback.' });
    }
    if (!user.canProcessFeedback()) {
      return res.status(429).json({
        error: `Monthly feedback limit reached. Upgrade to Pro for more.`,
        upgradeRequired: true
      });
    }

    const { url, additionalContext } = req.body;
    const isLoom = url.includes('loom.com');

    const content = additionalContext
      ? `URL: ${url}\n\nAdditional Context:\n${additionalContext}`
      : `URL: ${url}`;

    const feedback = await Feedback.create({
      userId: req.workspace.ownerId,
      type: 'url',
      rawContent: content,
      sourceUrl: url,
      status: 'processing'
    });

    try {
      const gemini = createGeminiService(user.geminiApiKey);
      let aiResult;

      if (isLoom) {
        aiResult = await gemini.analyzeLoomTranscript(url);
      } else {
        const fullContent = additionalContext
          ? `Analyzing feedback from URL: ${url}\n\nUser provided context:\n${additionalContext}`
          : `Analyzing feedback/content from URL: ${url}. Generate appropriate UI/UX improvement tasks based on common issues found in web applications.`;
        aiResult = await gemini.analyzeFeedback(fullContent, 'url');
      }

      const taskDocs = aiResult.tasks.map((task, index) => ({
        userId: req.workspace.ownerId,
        feedbackId: feedback._id,
        title: task.title,
        description: task.description,
        priority: task.priority,
        category: task.category,
        suggestion: task.suggestion,
        tailwindFix: task.tailwindFix,
        estimatedMinutes: task.estimatedMinutes || 30,
        status: 'Todo',
        order: index
      }));

      const createdTasks = await Task.insertMany(taskDocs);

      feedback.status = 'completed';
      feedback.processedAt = new Date();
      feedback.aiResponse = aiResult;
      feedback.tasksGenerated = createdTasks.length;
      await feedback.save();

      user.usage.feedbackCount += 1;
      await user.save({ validateBeforeSave: false });

      res.status(201).json({
        feedback: {
          id: feedback._id,
          status: feedback.status,
          tasksGenerated: feedback.tasksGenerated,
          summary: aiResult.summary,
          overallInsights: aiResult.overallInsights,
          quickWins: aiResult.quickWins
        },
        tasks: createdTasks
      });
    } catch (aiErr) {
      feedback.status = 'failed';
      feedback.error = aiErr.message;
      await feedback.save();
      throw aiErr;
    }
  } catch (err) {
    next(err);
  }
});

// POST /api/feedback/file - Process file upload
router.post('/file', protect, attachWorkspace, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    const user = req.user;
    if (!canViewAllTasks(req.workspace.member)) {
      return res.status(403).json({ error: 'Only admins and managers can process workspace feedback.' });
    }
    if (!user.canProcessFeedback()) {
      return res.status(429).json({
        error: `Monthly feedback limit reached. Upgrade to Pro for more.`,
        upgradeRequired: true
      });
    }

    const isImageUpload = isImageFile(req.file);
    const isVisionImageUpload = isVisionImageFile(req.file);
    const taskGroup = getSafeTaskGroupName(req.body?.taskGroup, req.file.originalname);
    let extractedText = '';

    if (!isVisionImageUpload) {
      try {
        extractedText = await extractFileText(req.file);
      } catch (extractErr) {
        return res.status(400).json({ error: 'Could not extract text from file. Please check file format.' });
      }

      if (!extractedText || extractedText.trim().length < 10) {
        return res.status(400).json({ error: 'File appears to be empty or contains no readable text.' });
      }
    }

    const feedback = await Feedback.create({
      userId: req.workspace.ownerId,
      type: 'file',
      rawContent: isImageUpload
        ? `[Image Upload] ${req.file.originalname}`
        : extractedText.substring(0, 50000),
      fileName: req.file.originalname,
      taskGroup,
      status: 'processing'
    });

    try {
      const gemini = createGeminiService(user.geminiApiKey);
      const aiResult = isVisionImageUpload
        ? await gemini.analyzeImageFeedback(req.file.buffer, req.file.mimetype, req.file.originalname)
        : await gemini.analyzeFeedback(extractedText, 'file');

      const taskDocs = aiResult.tasks.map((task, index) => ({
        userId: req.workspace.ownerId,
        feedbackId: feedback._id,
        taskGroup,
        title: task.title,
        description: task.description,
        priority: task.priority,
        category: task.category,
        suggestion: task.suggestion,
        tailwindFix: task.tailwindFix,
        estimatedMinutes: task.estimatedMinutes || 30,
        status: 'Todo',
        order: index
      }));

      const createdTasks = await Task.insertMany(taskDocs);

      feedback.status = 'completed';
      feedback.processedAt = new Date();
      feedback.aiResponse = aiResult;
      feedback.tasksGenerated = createdTasks.length;
      await feedback.save();

      user.usage.feedbackCount += 1;
      await user.save({ validateBeforeSave: false });

      res.status(201).json({
        feedback: {
          id: feedback._id,
          status: feedback.status,
          taskGroup,
          tasksGenerated: feedback.tasksGenerated,
          summary: aiResult.summary,
          overallInsights: aiResult.overallInsights,
          quickWins: aiResult.quickWins
        },
        tasks: createdTasks
      });
    } catch (aiErr) {
      feedback.status = 'failed';
      feedback.error = aiErr.message;
      await feedback.save();
      throw aiErr;
    }
  } catch (err) {
    next(err);
  }
});

// DELETE /api/feedback/:id
router.delete('/:id', protect, attachWorkspace, async (req, res, next) => {
  try {
    if (!canViewAllTasks(req.workspace.member)) {
      return res.status(403).json({ error: 'Only admins and managers can delete workspace feedback.' });
    }
    const feedback = await Feedback.findOne({ _id: req.params.id, userId: req.workspace.ownerId });
    if (!feedback) {
      return res.status(404).json({ error: 'Feedback not found.' });
    }

    await Promise.all([
      feedback.deleteOne(),
      Task.deleteMany({ feedbackId: feedback._id })
    ]);

    res.json({ message: 'Feedback and associated tasks deleted.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
