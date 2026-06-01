const express = require('express');
const { body, validationResult } = require('express-validator');
const Sprint = require('../models/Sprint');
const SprintTask = require('../models/SprintTask');
const Task = require('../models/Task');
const WorkspaceMember = require('../models/WorkspaceMember');
const { protect } = require('../middleware/auth');
const { recordActivity } = require('../services/activity');
const {
  attachWorkspace,
  canAssignTasks,
  canViewAllTasks,
  taskVisibilityFilter
} = require('../utils/permissions');

const router = express.Router();

const toId = (value) => value?._id || value?.id || value || null;

const sprintTaskToCard = (entry) => {
  const task = entry.taskId;
  if (!task) return null;
  return {
    id: task._id,
    sourceTaskId: task._id,
    assignedToId: toId(task.assignedTo),
    title: task.title,
    description: task.description,
    priority: task.priority || 'Medium',
    category: task.category || 'Other',
    impactScore: entry.impactScore,
    effortScore: entry.effortScore,
    estimatedHours: entry.estimatedHours,
    estimatedMinutes: task.estimatedMinutes || Math.round((entry.estimatedHours || 0) * 60) || 30,
    selectedReason: entry.aiReason,
    suggestedRole: task.assignedTo ? `${task.assignedTo.name || task.assignedTo.email} · ${task.assignedTo.role}` : 'Assign member',
    suggestedAssignee: task.assignedTo ? {
      id: task.assignedTo._id,
      name: task.assignedTo.name || task.assignedTo.email,
      email: task.assignedTo.email,
      role: task.assignedTo.role,
      source: 'assigned'
    } : null,
    repeatedCount: entry.repeatedCount,
    score: 0
  };
};

const serializeSprint = async (sprint, workspace) => {
  if (!sprint) return null;

  const entries = await SprintTask.find({ sprintId: sprint._id })
    .populate({
      path: 'taskId',
      match: taskVisibilityFilter(workspace),
      populate: { path: 'assignedTo', select: 'name email role status' }
    })
    .sort({ order: 1 })
    .lean();

  const highImpactTasks = [];
  const quickWins = [];
  entries.forEach(entry => {
    const card = sprintTaskToCard(entry);
    if (!card) return;
    if (entry.type === 'highImpact') highImpactTasks.push(card);
    if (entry.type === 'quickWin') quickWins.push(card);
  });
  const cards = [...highImpactTasks, ...quickWins];

  return {
    id: sprint._id,
    title: sprint.title,
    status: sprint.status,
    totalTasksAnalyzed: canViewAllTasks(workspace.member) ? sprint.totalTasksAnalyzed : cards.length,
    highImpactCount: canViewAllTasks(workspace.member) ? sprint.highImpactCount : highImpactTasks.length,
    quickWinsCount: canViewAllTasks(workspace.member) ? sprint.quickWinsCount : quickWins.length,
    estimatedSprintHours: cards.reduce((sum, task) => sum + (task.estimatedHours || 0), 0),
    insight: sprint.aiSummary,
    generatedAt: sprint.createdAt,
    updatedAt: sprint.updatedAt,
    highImpactTasks,
    quickWins
  };
};

router.get('/active', protect, attachWorkspace, async (req, res, next) => {
  try {
    const sprint = await Sprint.findOne({
      workspaceId: req.workspace.ownerId,
      status: 'active'
    }).sort({ createdAt: -1 }).lean();

    res.json({ sprint: await serializeSprint(sprint, req.workspace) });
  } catch (err) {
    next(err);
  }
});

router.post('/', protect, attachWorkspace, [
  body('title').optional().trim().isLength({ max: 120 }).withMessage('Title max length is 120 characters'),
  body('replaceExisting').optional().isBoolean(),
  body('plan').isObject().withMessage('Sprint plan is required')
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    if (!canViewAllTasks(req.workspace.member)) {
      return res.status(403).json({ error: 'Only admins and managers can generate sprint plans.' });
    }

    const active = await Sprint.findOne({ workspaceId: req.workspace.ownerId, status: 'active' });
    if (active && !req.body.replaceExisting) {
      return res.status(409).json({ error: 'An active sprint already exists. Confirm regeneration before replacing it.' });
    }

    if (active) {
      active.status = 'deleted';
      await active.save();
    }

    const plan = req.body.plan || {};
    const selected = [
      ...(plan.highImpactTasks || []).map((task, index) => ({ ...task, type: 'highImpact', order: index })),
      ...(plan.quickWins || []).map((task, index) => ({ ...task, type: 'quickWin', order: (plan.highImpactTasks || []).length + index }))
    ];

    const taskIds = selected.map(task => task.sourceTaskId || task.id).filter(Boolean);
    const realTasks = await Task.find({ _id: { $in: taskIds }, userId: req.workspace.ownerId }).select('_id').lean();
    const validTaskIds = new Set(realTasks.map(task => task._id.toString()));
    const invalid = taskIds.find(taskId => !validTaskIds.has(taskId.toString()));
    if (invalid) return res.status(400).json({ error: 'Sprint contains a task outside this workspace.' });

    const sprint = await Sprint.create({
      workspaceId: req.workspace.ownerId,
      title: req.body.title || 'AI Sprint Plan',
      estimatedHours: plan.estimatedSprintHours || 0,
      totalTasksAnalyzed: plan.totalTasksAnalyzed || 0,
      highImpactCount: plan.highImpactCount || 0,
      quickWinsCount: plan.quickWinsCount || 0,
      aiSummary: plan.insight || '',
      createdById: req.user._id
    });

    await SprintTask.insertMany(selected.map(task => ({
      sprintId: sprint._id,
      taskId: task.sourceTaskId || task.id,
      order: task.order,
      type: task.type,
      aiReason: task.selectedReason || '',
      impactScore: task.impactScore || 0,
      effortScore: task.effortScore || 0,
      estimatedHours: task.estimatedHours || 0,
      repeatedCount: task.repeatedCount || 1
    })));

    await recordActivity({
      ownerId: req.workspace.ownerId,
      actorId: req.user._id,
      type: active ? 'SPRINT_REGENERATED' : 'SPRINT_CREATED',
      message: active ? `Regenerated "${sprint.title}".` : `Created "${sprint.title}".`,
      metadata: { sprintId: sprint._id, replacedSprintId: active?._id || null }
    });

    res.status(201).json({ sprint: await serializeSprint(sprint, req.workspace) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', protect, attachWorkspace, async (req, res, next) => {
  try {
    if (!canViewAllTasks(req.workspace.member)) {
      return res.status(403).json({ error: 'Only admins and managers can delete sprint plans.' });
    }

    const sprint = await Sprint.findOne({
      _id: req.params.id,
      workspaceId: req.workspace.ownerId,
      status: 'active'
    });
    if (!sprint) return res.status(404).json({ error: 'Active sprint not found.' });

    sprint.status = 'deleted';
    await sprint.save();

    await recordActivity({
      ownerId: req.workspace.ownerId,
      actorId: req.user._id,
      type: 'SPRINT_DELETED',
      message: `Deleted "${sprint.title}".`,
      metadata: { sprintId: sprint._id }
    });

    res.json({ message: 'Sprint deleted. Original tasks were not deleted.' });
  } catch (err) {
    next(err);
  }
});

router.patch('/:sprintId/tasks/:taskId/assign', protect, attachWorkspace, [
  body('assignedToId').optional({ nullable: true }).custom(value => {
    if (value === null || value === '') return true;
    return /^[0-9a-fA-F]{24}$/.test(value);
  }).withMessage('Invalid assignee')
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    if (!canAssignTasks(req.workspace.member)) {
      return res.status(403).json({ error: 'You do not have permission to assign sprint tasks.' });
    }

    const sprint = await Sprint.findOne({
      _id: req.params.sprintId,
      workspaceId: req.workspace.ownerId,
      status: 'active'
    });
    if (!sprint) return res.status(404).json({ error: 'Active sprint not found.' });

    const sprintTask = await SprintTask.findOne({ sprintId: sprint._id, taskId: req.params.taskId });
    if (!sprintTask) return res.status(404).json({ error: 'Task is not part of this sprint.' });

    const task = await Task.findOne({ _id: req.params.taskId, userId: req.workspace.ownerId });
    if (!task) return res.status(404).json({ error: 'Task not found.' });

    const oldAssignedToId = task.assignedTo?.toString() || null;
    const newAssignedToId = req.body.assignedToId || null;
    let assignee = null;

    if (newAssignedToId) {
      assignee = await WorkspaceMember.findOne({
        _id: newAssignedToId,
        ownerId: req.workspace.ownerId,
        status: 'active'
      });
      if (!assignee) return res.status(400).json({ error: 'Assignee is not an active member of this workspace.' });
    }

    task.assignedTo = newAssignedToId;
    await task.save();

    await recordActivity({
      ownerId: req.workspace.ownerId,
      actorId: req.user._id,
      type: 'TASK_ASSIGNED_FROM_SPRINT',
      taskId: task._id,
      memberId: newAssignedToId,
      message: newAssignedToId
        ? `Assigned sprint task "${task.title}" to ${assignee?.name || assignee?.email}.`
        : `Unassigned sprint task "${task.title}".`,
      metadata: {
        sprintId: sprint._id,
        oldAssignedToId,
        newAssignedToId
      }
    });

    const populated = await Task.findById(task._id).populate('assignedTo', 'name email role status').lean();
    res.json({
      task: {
        ...populated,
        assignedToId: toId(populated.assignedTo)
      },
      sprint: await serializeSprint(sprint, req.workspace)
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
