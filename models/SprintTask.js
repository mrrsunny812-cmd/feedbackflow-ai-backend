const mongoose = require('mongoose');

const sprintTaskSchema = new mongoose.Schema({
  sprintId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Sprint',
    required: true,
    index: true
  },
  taskId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task',
    required: true,
    index: true
  },
  order: {
    type: Number,
    default: 0
  },
  type: {
    type: String,
    enum: ['highImpact', 'quickWin'],
    required: true,
    index: true
  },
  aiReason: {
    type: String,
    default: '',
    maxlength: 2000
  },
  impactScore: {
    type: Number,
    default: 0
  },
  effortScore: {
    type: Number,
    default: 0
  },
  estimatedHours: {
    type: Number,
    default: 0
  },
  repeatedCount: {
    type: Number,
    default: 1
  }
}, { timestamps: true });

sprintTaskSchema.index({ sprintId: 1, order: 1 });
sprintTaskSchema.index({ sprintId: 1, taskId: 1 }, { unique: true });

const SprintTask = mongoose.model('SprintTask', sprintTaskSchema);
module.exports = SprintTask;
