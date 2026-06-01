const mongoose = require('mongoose');

const timerExtensionSchema = new mongoose.Schema({
  timerSessionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TaskTimer',
    required: true,
    index: true
  },
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
  addedMinutes: {
    type: Number,
    required: true,
    min: 1,
    max: 480
  },
  reason: {
    type: String,
    default: 'extra_time',
    maxlength: 200
  }
}, { timestamps: true });

const TimerExtension = mongoose.model('TimerExtension', timerExtensionSchema);
module.exports = TimerExtension;
