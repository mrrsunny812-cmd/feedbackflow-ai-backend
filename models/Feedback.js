const mongoose = require('mongoose');

const feedbackSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  type: {
    type: String,
    enum: ['text', 'url', 'file'],
    required: true
  },
  rawContent: {
    type: String,
    required: true,
    maxlength: [50000, 'Feedback content too large']
  },
  sourceUrl: {
    type: String,
    default: null
  },
  fileName: {
    type: String,
    default: null
  },
  taskGroup: {
    type: String,
    trim: true,
    maxlength: [100, 'Task group too long'],
    default: null
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed'],
    default: 'pending'
  },
  processedAt: {
    type: Date,
    default: null
  },
  aiResponse: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  tasksGenerated: {
    type: Number,
    default: 0
  },
  error: {
    type: String,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
});

feedbackSchema.index({ userId: 1, createdAt: -1 });

const Feedback = mongoose.model('Feedback', feedbackSchema);
module.exports = Feedback;
