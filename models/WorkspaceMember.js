const mongoose = require('mongoose');

const ROLES = ['Admin', 'Manager', 'Developer', 'Designer', 'Viewer'];

const workspaceMemberSchema = new mongoose.Schema({
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  name: {
    type: String,
    trim: true,
    maxlength: [80, 'Name too long'],
    default: null
  },
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email']
  },
  role: {
    type: String,
    enum: ROLES,
    default: 'Developer'
  },
  status: {
    type: String,
    enum: ['active', 'pending'],
    default: 'pending',
    index: true
  },
  invitedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  invitedAt: {
    type: Date,
    default: Date.now
  },
  joinedAt: {
    type: Date,
    default: null
  }
}, { timestamps: true });

workspaceMemberSchema.index({ ownerId: 1, email: 1 }, { unique: true });
workspaceMemberSchema.index({ ownerId: 1, role: 1 });

workspaceMemberSchema.statics.roles = ROLES;

const WorkspaceMember = mongoose.model('WorkspaceMember', workspaceMemberSchema);
module.exports = WorkspaceMember;
