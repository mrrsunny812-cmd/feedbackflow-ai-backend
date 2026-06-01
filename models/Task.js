const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  feedbackId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Feedback',
    default: null
  },
  title: {
    type: String,
    required: [true, 'Title is required'],
    trim: true,
    maxlength: [200, 'Title too long']
  },
  description: {
    type: String,
    required: [true, 'Description is required'],
    maxlength: [2000, 'Description too long']
  },
  priority: {
    type: String,
    enum: ['Low', 'Medium', 'High'],
    required: true,
    default: 'Medium'
  },
  category: {
    type: String,
    enum: ['UI', 'UX', 'Bug', 'Performance', 'Feature', 'Other'],
    required: true,
    default: 'Other'
  },
  status: {
    type: String,
    enum: ['Todo', 'In Progress', 'Done'],
    default: 'Todo',
    index: true
  },
  suggestion: {
    type: String,
    default: null,
    maxlength: [2000, 'Suggestion too long']
  },
  tailwindFix: {
    type: String,
    default: null
  },
  estimatedMinutes: {
    type: Number,
    default: 30,
    min: 1,
    max: 10080
  },
  order: {
    type: Number,
    default: 0
  },
  tags: [{
    type: String,
    trim: true
  }],
  taskGroup: {
    type: String,
    trim: true,
    maxlength: [100, 'Task group too long'],
    default: null,
    index: true
  },
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WorkspaceMember',
    default: null,
    index: true
  },
  completedAt: {
    type: Date,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

taskSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  if (this.status === 'Done' && !this.completedAt) {
    this.completedAt = new Date();
  } else if (this.status !== 'Done') {
    this.completedAt = null;
  }
  next();
});

taskSchema.index({ userId: 1, status: 1, priority: 1, createdAt: -1 });
taskSchema.index({ userId: 1, category: 1 });

const Task = mongoose.model('Task', taskSchema);
module.exports = Task;
