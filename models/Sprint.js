const mongoose = require('mongoose');

const sprintSchema = new mongoose.Schema({
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 120,
    default: 'AI Sprint Plan'
  },
  status: {
    type: String,
    enum: ['active', 'completed', 'deleted'],
    default: 'active',
    index: true
  },
  estimatedHours: {
    type: Number,
    default: 0
  },
  totalTasksAnalyzed: {
    type: Number,
    default: 0
  },
  highImpactCount: {
    type: Number,
    default: 0
  },
  quickWinsCount: {
    type: Number,
    default: 0
  },
  aiSummary: {
    type: String,
    default: '',
    maxlength: 2000
  },
  createdById: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, { timestamps: true });

sprintSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });

const Sprint = mongoose.model('Sprint', sprintSchema);
module.exports = Sprint;
