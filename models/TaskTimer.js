const mongoose = require('mongoose');

const taskTimerSchema = new mongoose.Schema({
  taskId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task',
    required: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  memberId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WorkspaceMember',
    required: true,
    index: true
  },
  startTime: {
    type: Date,
    required: true,
    default: Date.now
  },
  endTime: {
    type: Date,
    default: null
  },
  durationSeconds: {
    type: Number,
    default: 0
  },
  estimatedMinutesAtStart: {
    type: Number,
    default: 30
  },
  extraMinutesAdded: {
    type: Number,
    default: 0
  },
  totalPausedSeconds: {
    type: Number,
    default: 0
  },
  pausedAt: {
    type: Date,
    default: null
  },
  status: {
    type: String,
    enum: ['running', 'paused', 'stopped'],
    default: 'running',
    index: true
  }
}, { timestamps: true });

taskTimerSchema.index(
  { userId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'running' }, name: 'one_running_timer_per_user' }
);
taskTimerSchema.index(
  { userId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'paused' }, name: 'one_paused_timer_per_user' }
);
taskTimerSchema.index({ workspaceId: 1, createdAt: -1 });

const TaskTimer = mongoose.model('TaskTimer', taskTimerSchema);
module.exports = TaskTimer;
