const mongoose = require('mongoose');

const activitySchema = new mongoose.Schema({
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  actorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  type: {
    type: String,
    enum: [
      'member.invited',
      'task.assigned',
      'task.unassigned',
      'TASK_ASSIGNED',
      'TASK_UNASSIGNED',
      'task.updated',
      'task.created',
      'task.status_changed',
      'task.completed',
      'timer.started',
      'timer.stopped',
      'comment.added',
      'SPRINT_CREATED',
      'SPRINT_DELETED',
      'SPRINT_REGENERATED',
      'TASK_ASSIGNED_FROM_SPRINT'
    ],
    required: true,
    index: true
  },
  taskId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task',
    default: null
  },
  memberId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WorkspaceMember',
    default: null
  },
  message: {
    type: String,
    required: true,
    maxlength: 300
  },
  metadata: {
    type: Object,
    default: {}
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
});

activitySchema.index({ ownerId: 1, createdAt: -1 });

const Activity = mongoose.model('Activity', activitySchema);
module.exports = Activity;
