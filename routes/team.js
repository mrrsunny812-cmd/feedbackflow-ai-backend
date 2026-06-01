const express = require('express');
const { body, validationResult } = require('express-validator');
const WorkspaceMember = require('../models/WorkspaceMember');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const { sendMail } = require('../services/mailer');
const { recordActivity } = require('../services/activity');
const { attachWorkspace, canInviteMembers, canManageMembers } = require('../utils/permissions');

const router = express.Router();

const serializeMember = (member) => ({
  id: member._id,
  name: member.name,
  email: member.email,
  role: member.role,
  status: member.status,
  avatar: member.userId?.avatar || null,
  userId: member.userId?._id || member.userId || null,
  invitedAt: member.invitedAt,
  joinedAt: member.joinedAt,
  createdAt: member.createdAt
});

router.get('/members', protect, attachWorkspace, async (req, res, next) => {
  try {
    const members = await WorkspaceMember.find({ ownerId: req.workspace.ownerId })
      .populate('userId', 'avatar')
      .sort({ status: 1, createdAt: 1 })
      .lean();

    res.json({
      members: members.map(serializeMember),
      roles: WorkspaceMember.roles,
      currentMember: serializeMember(req.workspace.member),
      permissions: req.workspace.permissions
    });
  } catch (err) {
    next(err);
  }
});

router.post('/members/invite', protect, attachWorkspace, [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('role').isIn(WorkspaceMember.roles).withMessage('Invalid role')
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    if (!canInviteMembers(req.workspace.member)) {
      return res.status(403).json({ error: 'Only workspace admins can invite members.' });
    }

    const { email, role } = req.body;
    const existing = await WorkspaceMember.findOne({ ownerId: req.workspace.ownerId, email });
    if (existing) {
      return res.status(409).json({ error: 'This email is already in the workspace.' });
    }

    const existingUser = await User.findOne({ email });
    const member = await WorkspaceMember.create({
      ownerId: req.workspace.ownerId,
      userId: existingUser?._id || null,
      name: existingUser?.name || email.split('@')[0],
      email,
      role,
      status: existingUser ? 'active' : 'pending',
      invitedBy: req.user._id,
      joinedAt: existingUser ? new Date() : null
    });

    const inviteUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/signup`;
    try {
      await sendMail({
        to: email,
        subject: 'You were invited to FeedbackFlow',
        text: `${req.user.name} invited you to collaborate in FeedbackFlow. Join here: ${inviteUrl}`,
        html: `<p>${req.user.name} invited you to collaborate in FeedbackFlow.</p><p><a href="${inviteUrl}">Join workspace</a></p>`
      });
    } catch (err) {
      console.error('Invite email failed:', err.message);
    }

    await recordActivity({
      ownerId: req.workspace.ownerId,
      actorId: req.user._id,
      type: 'member.invited',
      memberId: member._id,
      message: `${req.user.name} invited ${email} as ${role}.`,
      metadata: { email, role }
    });

    const populated = await WorkspaceMember.findById(member._id).populate('userId', 'avatar').lean();
    res.status(201).json({ member: serializeMember(populated) });
  } catch (err) {
    next(err);
  }
});

router.patch('/members/:id', protect, attachWorkspace, [
  body('role').optional().isIn(WorkspaceMember.roles).withMessage('Invalid role'),
  body('name').optional().trim().isLength({ min: 1, max: 80 }).withMessage('Name must be 1-80 characters')
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    if (!canManageMembers(req.workspace.member)) {
      return res.status(403).json({ error: 'Only workspace admins can change member roles.' });
    }

    const member = await WorkspaceMember.findOne({ _id: req.params.id, ownerId: req.workspace.ownerId });
    if (!member) return res.status(404).json({ error: 'Member not found.' });

    if (req.body.role) {
      if (member._id.toString() === req.workspace.member._id.toString()) {
        return res.status(403).json({ error: 'You cannot change your own role.' });
      }
      member.role = req.body.role;
    }
    if (req.body.name) member.name = req.body.name;
    await member.save();

    const populated = await WorkspaceMember.findById(member._id).populate('userId', 'avatar').lean();
    res.json({ member: serializeMember(populated) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
