const express = require('express');
const Activity = require('../models/Activity');
const { protect } = require('../middleware/auth');
const { attachWorkspace, canViewAllTasks } = require('../utils/permissions');

const router = express.Router();

router.get('/', protect, attachWorkspace, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    const filter = { ownerId: req.workspace.ownerId };
    if (!canViewAllTasks(req.workspace.member)) {
      filter.actorId = req.user._id;
    }

    const activities = await Activity.find(filter)
      .populate('actorId', 'name email avatar')
      .populate('taskId', 'title')
      .populate('memberId', 'name email role status')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.json({
      activities: activities.map(activity => ({
        id: activity._id,
        type: activity.type,
        message: activity.message,
        actor: activity.actorId ? {
          id: activity.actorId._id,
          name: activity.actorId.name,
          email: activity.actorId.email,
          avatar: activity.actorId.avatar
        } : null,
        task: activity.taskId ? { id: activity.taskId._id, title: activity.taskId.title } : null,
        member: activity.memberId ? {
          id: activity.memberId._id,
          name: activity.memberId.name,
          email: activity.memberId.email,
          role: activity.memberId.role,
          status: activity.memberId.status
        } : null,
        metadata: activity.metadata || {},
        createdAt: activity.createdAt
      }))
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
