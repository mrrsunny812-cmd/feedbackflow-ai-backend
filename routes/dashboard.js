const express = require('express');
const Task = require('../models/Task');
const Feedback = require('../models/Feedback');
const { protect } = require('../middleware/auth');
const { attachWorkspace, taskVisibilityFilter } = require('../utils/permissions');

const router = express.Router();

// GET /api/dashboard/stats
router.get('/stats', protect, attachWorkspace, async (req, res, next) => {
  try {
    const taskFilter = taskVisibilityFilter(req.workspace);
    const userId = req.workspace.ownerId;

    const [
      totalTasks,
      completedTasks,
      inProgressTasks,
      todoTasks,
      totalFeedback,
      tasksByPriority,
      tasksByCategory,
      recentActivity,
      weeklyCreation
    ] = await Promise.all([
      Task.countDocuments(taskFilter),
      Task.countDocuments({ ...taskFilter, status: 'Done' }),
      Task.countDocuments({ ...taskFilter, status: 'In Progress' }),
      Task.countDocuments({ ...taskFilter, status: 'Todo' }),
      Feedback.countDocuments({ userId, status: 'completed' }),

      Task.aggregate([
        { $match: taskFilter },
        { $group: { _id: '$priority', count: { $sum: 1 } } }
      ]),

      Task.aggregate([
        { $match: taskFilter },
        { $group: { _id: '$category', count: { $sum: 1 } } }
      ]),

      Task.find(taskFilter)
        .sort({ updatedAt: -1 })
        .limit(5)
        .select('title status priority category updatedAt')
        .lean(),

      // Last 7 days task creation
      Task.aggregate([
        {
          $match: {
            ...taskFilter,
            createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
          }
        },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            count: { $sum: 1 }
          }
        },
        { $sort: { _id: 1 } }
      ])
    ]);

    // Build complete week data
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const found = weeklyCreation.find(w => w._id === dateStr);
      days.push({
        date: dateStr,
        label: d.toLocaleDateString('en-US', { weekday: 'short' }),
        count: found ? found.count : 0
      });
    }

    res.json({
      stats: {
        totalTasks,
        completedTasks,
        inProgressTasks,
        todoTasks,
        totalFeedback,
        completionRate: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0
      },
      tasksByPriority: tasksByPriority.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
      }, { High: 0, Medium: 0, Low: 0 }),
      tasksByCategory: tasksByCategory.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
      }, {}),
      recentActivity,
      weeklyCreation: days,
      usage: {
        feedbackCount: req.user.usage.feedbackCount,
        limit: req.user.getUsageLimit(),
        plan: req.user.plan,
        resetDate: req.user.usage.resetDate
      }
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
