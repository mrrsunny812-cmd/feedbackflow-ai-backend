const express = require('express');
const { body, query, validationResult } = require('express-validator');
const Task = require('../models/Task');
const TaskTimer = require('../models/TaskTimer');
const TimerExtension = require('../models/TimerExtension');
const WorkspaceMember = require('../models/WorkspaceMember');
const { protect } = require('../middleware/auth');
const { recordActivity } = require('../services/activity');
const {
  attachWorkspace,
  taskVisibilityFilter,
  canAssignTasks,
  canEditTasks,
  canViewAllTasks
} = require('../utils/permissions');

const router = express.Router();

const serializeTask = (task, timeStats = null) => ({
  ...task,
  assignedToId: task.assignedTo?._id || task.assignedTo || null,
  timeStats: timeStats || {
    estimatedMinutes: task.estimatedMinutes || 30,
    actualSeconds: 0,
    actualMinutes: 0,
    extraMinutesAdded: 0,
    sessionCount: 0,
    differenceMinutes: 0
  }
});

const getTaskTimeStats = async (taskIds) => {
  const ids = taskIds.map(id => id.toString());
  if (!ids.length) return new Map();

  const [sessions, extensions] = await Promise.all([
    TaskTimer.find({ taskId: { $in: ids } }).select('taskId durationSeconds extraMinutesAdded status startTime totalPausedSeconds').lean(),
    TimerExtension.find({ taskId: { $in: ids } }).select('taskId addedMinutes').lean()
  ]);

  const stats = new Map();
  sessions.forEach(session => {
    const key = session.taskId.toString();
    const existing = stats.get(key) || { actualSeconds: 0, extraMinutesAdded: 0, sessionCount: 0 };
    let duration = session.durationSeconds || 0;
    if (session.status === 'running') {
      duration += Math.max(0, Math.round((Date.now() - new Date(session.startTime).getTime()) / 1000) - (session.totalPausedSeconds || 0));
    }
    existing.actualSeconds += duration;
    existing.sessionCount += 1;
    stats.set(key, existing);
  });

  extensions.forEach(extension => {
    const key = extension.taskId.toString();
    const existing = stats.get(key) || { actualSeconds: 0, extraMinutesAdded: 0, sessionCount: 0 };
    existing.extraMinutesAdded += extension.addedMinutes || 0;
    stats.set(key, existing);
  });

  return stats;
};

const withTimeStats = async (tasks) => {
  const timeStats = await getTaskTimeStats(tasks.map(task => task._id));
  return tasks.map(task => {
    const stats = timeStats.get(task._id.toString()) || { actualSeconds: 0, extraMinutesAdded: 0, sessionCount: 0 };
    const estimatedMinutes = task.estimatedMinutes || 30;
    const actualMinutes = Math.round(stats.actualSeconds / 60);
    return serializeTask(task, {
      estimatedMinutes,
      actualSeconds: stats.actualSeconds,
      actualMinutes,
      extraMinutesAdded: stats.extraMinutesAdded,
      sessionCount: stats.sessionCount,
      differenceMinutes: actualMinutes - estimatedMinutes
    });
  });
};

// GET /api/tasks - List tasks with filters, search, pagination
router.get('/', protect, attachWorkspace, async (req, res, next) => {
  try {
    const {
      status, priority, category, taskGroup, search,
      page = 1, limit = 50, sortBy = 'createdAt', sortOrder = 'desc'
    } = req.query;

    const filter = taskVisibilityFilter(req.workspace);

    if (status && status !== 'all') filter.status = status;
    if (priority && priority !== 'all') filter.priority = priority;
    if (category && category !== 'all') filter.category = category;
    if (taskGroup && taskGroup !== 'all') filter.taskGroup = taskGroup;

    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sortDir = sortOrder === 'asc' ? 1 : -1;
    const allowedSortFields = ['createdAt', 'updatedAt', 'priority', 'status', 'title'];
    const sort = { [allowedSortFields.includes(sortBy) ? sortBy : 'createdAt']: sortDir };

    const [tasks, total] = await Promise.all([
      Task.find(filter).populate('assignedTo', 'name email role status').sort(sort).skip(skip).limit(parseInt(limit)).lean(),
      Task.countDocuments(filter)
    ]);

    res.json({
      tasks: await withTimeStats(tasks),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/tasks/:id - Get single task
router.get('/:id([0-9a-fA-F]{24})', protect, attachWorkspace, async (req, res, next) => {
  try {
    const task = await Task.findOne(taskVisibilityFilter(req.workspace, { _id: req.params.id })).populate('assignedTo', 'name email role status').lean();
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    res.json({ task: (await withTimeStats([task]))[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/tasks - Create task manually
router.post('/', protect, attachWorkspace, [
  body('title').trim().isLength({ min: 3, max: 200 }).withMessage('Title must be 3-200 characters'),
  body('description').trim().isLength({ min: 5, max: 2000 }).withMessage('Description must be 5-2000 characters'),
  body('priority').isIn(['Low', 'Medium', 'High']).withMessage('Invalid priority'),
  body('category').isIn(['UI', 'UX', 'Bug', 'Performance', 'Feature', 'Other']).withMessage('Invalid category'),
  body('status').optional().isIn(['Todo', 'In Progress', 'Done']).withMessage('Invalid status'),
  body('estimatedMinutes').optional().isInt({ min: 1, max: 10080 }).withMessage('Invalid estimated minutes'),
  body('taskGroup').optional().trim().isLength({ max: 100 }).withMessage('Task group max length is 100 characters'),
  body('assignedTo').optional({ nullable: true }).isMongoId().withMessage('Invalid assignee')
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    if (!canEditTasks(req.workspace.member)) {
      return res.status(403).json({ error: 'Viewers cannot create tasks.' });
    }

    const { title, description, priority, category, status, suggestion, tailwindFix, taskGroup, estimatedMinutes } = req.body;
    const assignedTo = req.body.assignedTo || req.body.assignedToId || null;

    let assignee = null;
    if (assignedTo) {
      if (!canAssignTasks(req.workspace.member)) {
        return res.status(403).json({ error: 'You do not have permission to assign tasks.' });
      }
      assignee = await WorkspaceMember.findOne({ _id: assignedTo, ownerId: req.workspace.ownerId });
      if (!assignee) return res.status(400).json({ error: 'Assignee is not in this workspace.' });
    }

    const task = await Task.create({
      userId: req.workspace.ownerId,
      title, description, priority, category,
      status: status || 'Todo',
      suggestion: suggestion || null,
      tailwindFix: tailwindFix || null,
      estimatedMinutes: estimatedMinutes || 30,
      taskGroup: taskGroup?.trim() || null,
      assignedTo: assignee?._id || null
    });

    await recordActivity({
      ownerId: req.workspace.ownerId,
      actorId: req.user._id,
      type: 'task.created',
      taskId: task._id,
      memberId: assignee?._id || null,
      message: assignee ? `Created "${title}" and assigned it to ${assignee.name || assignee.email}.` : `Created "${title}".`
    });

    const populated = await Task.findById(task._id).populate('assignedTo', 'name email role status').lean();
    res.status(201).json({ task: (await withTimeStats([populated]))[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/tasks/:id - Update task
router.patch('/:id([0-9a-fA-F]{24})', protect, attachWorkspace, [
  body('title').optional().trim().isLength({ min: 3, max: 200 }),
  body('description').optional().trim().isLength({ min: 5, max: 2000 }),
  body('priority').optional().isIn(['Low', 'Medium', 'High']),
  body('category').optional().isIn(['UI', 'UX', 'Bug', 'Performance', 'Feature', 'Other']),
  body('status').optional().isIn(['Todo', 'In Progress', 'Done']),
  body('estimatedMinutes').optional().isInt({ min: 1, max: 10080 }),
  body('taskGroup').optional().trim().isLength({ max: 100 }),
  body('assignedTo').optional({ nullable: true }).custom(value => {
    if (value === null || value === '') return true;
    return /^[0-9a-fA-F]{24}$/.test(value);
  }).withMessage('Invalid assignee'),
  body('assignedToId').optional({ nullable: true }).custom(value => {
    if (value === null || value === '') return true;
    return /^[0-9a-fA-F]{24}$/.test(value);
  }).withMessage('Invalid assignee')
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    if (!canEditTasks(req.workspace.member)) {
      return res.status(403).json({ error: 'Viewers cannot edit tasks.' });
    }

    const task = await Task.findOne(taskVisibilityFilter(req.workspace, { _id: req.params.id }));
    if (!task) return res.status(404).json({ error: 'Task not found.' });

    const previousAssignedTo = task.assignedTo?.toString() || null;
    if (req.body.assignedToId !== undefined && req.body.assignedTo === undefined) {
      req.body.assignedTo = req.body.assignedToId;
    }

    if (req.body.assignedTo !== undefined && !canAssignTasks(req.workspace.member)) {
      return res.status(403).json({ error: 'You do not have permission to assign tasks.' });
    }

    let assignee = null;
    if (req.body.assignedTo) {
      assignee = await WorkspaceMember.findOne({ _id: req.body.assignedTo, ownerId: req.workspace.ownerId });
      if (!assignee) return res.status(400).json({ error: 'Assignee is not in this workspace.' });
    }

    const allowedFields = ['title', 'description', 'priority', 'category', 'status', 'suggestion', 'tailwindFix', 'tags', 'taskGroup', 'assignedTo', 'estimatedMinutes'];
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        if (field === 'taskGroup') {
          task[field] = req.body[field]?.trim() || null;
        } else if (field === 'assignedTo') {
          task[field] = req.body[field] || null;
        } else {
          task[field] = req.body[field];
        }
      }
    });

    await task.save();

    const newAssignedTo = task.assignedTo?.toString() || null;
    if (previousAssignedTo !== newAssignedTo) {
      await recordActivity({
        ownerId: req.workspace.ownerId,
        actorId: req.user._id,
        type: newAssignedTo ? 'TASK_ASSIGNED' : 'TASK_UNASSIGNED',
        taskId: task._id,
        memberId: newAssignedTo || null,
        message: newAssignedTo
          ? `Assigned "${task.title}" to ${assignee?.name || assignee?.email || 'a team member'}.`
          : `Unassigned "${task.title}".`,
        metadata: {
          oldAssignedToId: previousAssignedTo,
          newAssignedToId: newAssignedTo
        }
      });
    } else {
      await recordActivity({
        ownerId: req.workspace.ownerId,
        actorId: req.user._id,
        type: req.body.status === 'Done' ? 'task.completed' : (req.body.status ? 'task.status_changed' : 'task.updated'),
        taskId: task._id,
        message: `Updated "${task.title}".`,
        metadata: { fields: Object.keys(req.body) }
      });
    }

    const populated = await Task.findById(task._id).populate('assignedTo', 'name email role status').lean();
    res.json({ task: (await withTimeStats([populated]))[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/tasks/bulk/status - Bulk update status
router.patch('/bulk/status', protect, [
  body('taskIds').isArray({ min: 1 }).withMessage('Task IDs array required'),
  body('status').isIn(['Todo', 'In Progress', 'Done']).withMessage('Invalid status')
], attachWorkspace, async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { taskIds, status } = req.body;
    if (!canEditTasks(req.workspace.member)) {
      return res.status(403).json({ error: 'Viewers cannot update tasks.' });
    }

    await Task.updateMany(
      taskVisibilityFilter(req.workspace, { _id: { $in: taskIds } }),
      { $set: { status, updatedAt: new Date() } }
    );

    res.json({ message: `${taskIds.length} tasks updated.` });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/tasks/:id - Delete task
router.delete('/:id([0-9a-fA-F]{24})', protect, attachWorkspace, async (req, res, next) => {
  try {
    if (!canViewAllTasks(req.workspace.member)) {
      return res.status(403).json({ error: 'Only admins and managers can delete tasks.' });
    }
    const task = await Task.findOneAndDelete({ _id: req.params.id, userId: req.workspace.ownerId });
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    res.json({ message: 'Task deleted.' });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/tasks/bulk/delete - Bulk delete
router.delete('/bulk/delete', protect, [
  body('taskIds').isArray({ min: 1 }).withMessage('Task IDs array required')
], attachWorkspace, async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { taskIds } = req.body;
    if (!canViewAllTasks(req.workspace.member)) {
      return res.status(403).json({ error: 'Only admins and managers can delete tasks.' });
    }
    const result = await Task.deleteMany({ _id: { $in: taskIds }, userId: req.workspace.ownerId });

    res.json({ message: `${result.deletedCount} tasks deleted.` });
  } catch (err) {
    next(err);
  }
});

// GET /api/tasks/export/data - Export tasks
router.get('/export/data', protect, attachWorkspace, async (req, res, next) => {
  try {
    const { format = 'json', status, priority, category, taskGroup } = req.query;

    const filter = taskVisibilityFilter(req.workspace);
    if (status && status !== 'all') filter.status = status;
    if (priority && priority !== 'all') filter.priority = priority;
    if (category && category !== 'all') filter.category = category;
    if (taskGroup && taskGroup !== 'all') filter.taskGroup = taskGroup;

    const tasks = await Task.find(filter).sort({ createdAt: -1 }).lean();

    if (format === 'csv') {
      const headers = ['Task Group', 'Title', 'Description', 'Priority', 'Category', 'Status', 'Created At'];
      const csvRows = [headers.join(',')];
      tasks.forEach(task => {
        const row = [
          `"${(task.taskGroup || '').replace(/"/g, '""')}"`,
          `"${(task.title || '').replace(/"/g, '""')}"`,
          `"${(task.description || '').replace(/"/g, '""')}"`,
          task.priority,
          task.category,
          task.status,
          new Date(task.createdAt).toISOString()
        ];
        csvRows.push(row.join(','));
      });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=feedbackflow-tasks.csv');
      return res.send(csvRows.join('\n'));
    }

    res.json({ tasks: await withTimeStats(tasks), exportedAt: new Date().toISOString(), total: tasks.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
