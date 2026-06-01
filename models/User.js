const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true,
    maxlength: [50, 'Name cannot exceed 50 characters']
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email']
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [8, 'Password must be at least 8 characters'],
    select: false
  },
  avatar: {
    type: String,
    default: null
  },
  plan: {
    type: String,
    enum: ['free', 'starter', 'pro', 'pro-max'],
    default: 'free'
  },
  usage: {
    feedbackCount: { type: Number, default: 0 },
    resetDate: { type: Date, default: () => new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1) }
  },
  geminiApiKey: {
    type: String,
    default: null,
    select: false
  },
  resetPasswordToken: {
    type: String,
    select: false
  },
  resetPasswordExpires: Date,
  preferences: {
    theme: { type: String, enum: ['light', 'dark', 'system'], default: 'system' },
    defaultView: { type: String, enum: ['kanban', 'list'], default: 'kanban' }
  },
  createdAt: { type: Date, default: Date.now },
  lastLoginAt: { type: Date, default: Date.now }
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Reset monthly usage if needed
userSchema.methods.checkAndResetUsage = function() {
  const now = new Date();
  if (now >= this.usage.resetDate) {
    this.usage.feedbackCount = 0;
    this.usage.resetDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  }
};

// Generate password reset token (returns raw token)
const crypto = require('crypto');
userSchema.methods.createPasswordResetToken = function() {
  const resetToken = crypto.randomBytes(32).toString('hex');
  this.resetPasswordToken = crypto.createHash('sha256').update(resetToken).digest('hex');
  // 1 hour
  this.resetPasswordExpires = Date.now() + 60 * 60 * 1000;
  return resetToken;
};

// Compare password
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Get usage limit based on plan
userSchema.methods.getUsageLimit = function() {
  switch(this.plan) {
    case 'free':
      return 2; // 2 feedbacks/month (changed from 10)
    case 'starter':
      return 50; // 50 feedbacks/month
    case 'pro':
      return 200; // 200 feedbacks/month
    case 'pro-max':
      return 999999; // Unlimited
    default:
      return 2;
  }
};

// Check if user can process more feedback
userSchema.methods.canProcessFeedback = function() {
  this.checkAndResetUsage();
  return this.usage.feedbackCount < this.getUsageLimit();
};

const User = mongoose.model('User', userSchema);
module.exports = User;
