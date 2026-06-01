const express = require('express');
const { Types } = require('mongoose');
const { body, validationResult } = require('express-validator');
const Task = require('../models/Task');
const TaskTimer = require('../models/TaskTimer');
const TimerExtension = require('../models/TimerExtension');
const { protect } = require('../middleware/auth');
const { recordActivity } = require('../services/activity');
const { attachWorkspace, canStartTimer, taskVisibilityFilter } = require('../utils/permissions');

const router = express.Router();

const activeStatuses = ['running', 'paused'];
const isValidTaskId = (taskId) => Types.ObjectId.isValid(taskId);

const elapsedSeconds = (timer) => {
  if (!timer) return 0;
  const end = timer.status === 'paused'
    ? new Date(timer.pausedAt || timer.endTime || Date.now())
    : new Date(timer.endTime || Date.now());
  return Math.max(0, Math.round((end - timer.startTime) / 1000) - (timer.totalPausedSeconds || 0));
};

const serializeTimer = (timer) => {
  if (!timer) return null;
  const raw = timer.toObject ? timer.toObject() : timer;
  return {
    ...raw,
    elapsedSeconds: elapsedSeconds(raw),
    totalAllowedSeconds: ((raw.estimatedMinutesAtStart || 30) + (raw.extraMinutesAdded || 0)) * 60
  };
};

const stopTimer = async (timer) => {
  if (!timer || !activeStatuses.includes(timer.status)) return timer;
  const endTime = new Date();
  if (timer.status === 'paused' && timer.pausedAt) {
    timer.totalPausedSeconds += Math.max(0, Math.round((endTime - timer.pausedAt) / 1000));
    timer.pausedAt = null;
  }
  timer.endTime = endTime;
  timer.durationSeconds = elapsedSeconds({ ...timer.toObject(), endTime, status: 'stopped' });
  timer.status = 'stopped';
  await timer.save();
  return timer;
};

router.get('/running', protect, attachWorkspace, async (req, res, next) => {
  try {
    const timer = await TaskTimer.findOne({
      userId: req.user._id,
      workspaceId: req.workspace.ownerId,
      status: { $in: activeStatuses }
    }).populate('taskId', 'title status assignedTo').lean();

    res.json({ timer: serializeTimer(timer) });
  } catch (err) {
    next(err);
  }
});

router.post('/tasks/:taskId/start', protect, attachWorkspace, async (req, res, next) => {
  try {
    if (!isValidTaskId(req.params.taskId)) {
      return res.status(400).json({ error: 'Invalid task id.' });
    }
    const task = await Task.findOne(taskVisibilityFilter(req.workspace, { _id: req.params.taskId }));
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    if (!canStartTimer(req.workspace.member, task)) {
      return res.status(403).json({ error: 'You can only start timers on tasks assigned to you.' });
    }

    const running = await TaskTimer.findOne({
      userId: req.user._id,
      workspaceId: req.workspace.ownerId,
      status: { $in: activeStatuses }
    });

    if (running && running.taskId.toString() !== task._id.toString()) {
      await stopTimer(running);
      await recordActivity({
        ownerId: req.workspace.ownerId,
        actorId: req.user._id,
        type: 'timer.stopped',
        taskId: running.taskId,
        memberId: req.workspace.member._id,
        message: `${req.user.name} stopped a running timer.`,
        metadata: { durationSeconds: running.durationSeconds, autoStopped: true }
      });
    } else if (running) {
      return res.json({ timer: running, message: 'Timer is already running.' });
    }

    const timer = await TaskTimer.create({
      taskId: task._id,
      userId: req.user._id,
      workspaceId: req.workspace.ownerId,
      memberId: req.workspace.member._id,
      startTime: new Date(),
      estimatedMinutesAtStart: task.estimatedMinutes || 30,
      status: 'running'
    });

    await recordActivity({
      ownerId: req.workspace.ownerId,
      actorId: req.user._id,
      type: 'timer.started',
      taskId: task._id,
      memberId: req.workspace.member._id,
      message: `${req.user.name} started "${task.title}".`
    });

    const populated = await TaskTimer.findById(timer._id).populate('taskId', 'title status assignedTo').lean();
    res.status(201).json({ timer: serializeTimer(populated) });
  } catch (err) {
    next(err);
  }
});

router.post('/tasks/:taskId/stop', protect, attachWorkspace, async (req, res, next) => {
  try {
    if (!isValidTaskId(req.params.taskId)) {
      return res.status(400).json({ error: 'Invalid task id.' });
    }
    const timer = await TaskTimer.findOne({
      taskId: req.params.taskId,
      userId: req.user._id,
      workspaceId: req.workspace.ownerId,
      status: { $in: activeStatuses }
    });

    if (!timer) return res.status(404).json({ error: 'No running timer found for this task.' });
    await stopTimer(timer);

    const task = await Task.findById(timer.taskId).select('title').lean();
    await recordActivity({
      ownerId: req.workspace.ownerId,
      actorId: req.user._id,
      type: 'timer.stopped',
      taskId: timer.taskId,
      memberId: req.workspace.member._id,
      message: `${req.user.name} stopped "${task?.title || 'a task'}".`,
      metadata: { durationSeconds: timer.durationSeconds }
    });

    res.json({ timer: serializeTimer(timer) });
  } catch (err) {
    next(err);
  }
});

router.post('/tasks/:taskId/pause', protect, attachWorkspace, async (req, res, next) => {
  try {
    if (!isValidTaskId(req.params.taskId)) {
      return res.status(400).json({ error: 'Invalid task id.' });
    }
    const timer = await TaskTimer.findOne({
      taskId: req.params.taskId,
      userId: req.user._id,
      workspaceId: req.workspace.ownerId,
      status: 'running'
    });
    if (!timer) return res.status(404).json({ error: 'No running timer found for this task.' });

    timer.status = 'paused';
    timer.pausedAt = new Date();
    await timer.save();
    res.json({ timer: serializeTimer(timer) });
  } catch (err) {
    next(err);
  }
});

router.post('/tasks/:taskId/resume', protect, attachWorkspace, async (req, res, next) => {
  try {
    if (!isValidTaskId(req.params.taskId)) {
      return res.status(400).json({ error: 'Invalid task id.' });
    }
    const timer = await TaskTimer.findOne({
      taskId: req.params.taskId,
      userId: req.user._id,
      workspaceId: req.workspace.ownerId,
      status: 'paused'
    });
    if (!timer) return res.status(404).json({ error: 'No paused timer found for this task.' });

    if (timer.pausedAt) {
      timer.totalPausedSeconds += Math.max(0, Math.round((Date.now() - timer.pausedAt.getTime()) / 1000));
    }
    timer.status = 'running';
    timer.pausedAt = null;
    await timer.save();
    res.json({ timer: serializeTimer(timer) });
  } catch (err) {
    next(err);
  }
});

router.post('/tasks/:taskId/extend', protect, attachWorkspace, [
  body('addedMinutes').isInt({ min: 1, max: 480 }).withMessage('Invalid extra time'),
  body('reason').optional().trim().isLength({ max: 200 })
], async (req, res, next) => {
  try {
    if (!isValidTaskId(req.params.taskId)) {
      return res.status(400).json({ error: 'Invalid task id.' });
    }
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const timer = await TaskTimer.findOne({
      taskId: req.params.taskId,
      userId: req.user._id,
      workspaceId: req.workspace.ownerId,
      status: { $in: activeStatuses }
    });
    if (!timer) return res.status(404).json({ error: 'No active timer found for this task.' });

    const addedMinutes = Number(req.body.addedMinutes);
    timer.extraMinutesAdded += addedMinutes;
    await timer.save();

    await TimerExtension.create({
      timerSessionId: timer._id,
      taskId: timer.taskId,
      userId: req.user._id,
      workspaceId: req.workspace.ownerId,
      addedMinutes,
      reason: req.body.reason || 'extra_time'
    });

    res.json({ timer: serializeTimer(timer) });
  } catch (err) {
    next(err);
  }
});

router.post('/tasks/:taskId/complete', protect, attachWorkspace, async (req, res, next) => {
  try {
    if (!isValidTaskId(req.params.taskId)) {
      return res.status(400).json({ error: 'Invalid task id.' });
    }
    const task = await Task.findOne(taskVisibilityFilter(req.workspace, { _id: req.params.taskId }));
    if (!task) return res.status(404).json({ error: 'Task not found.' });

    const timer = await TaskTimer.findOne({
      taskId: req.params.taskId,
      userId: req.user._id,
      workspaceId: req.workspace.ownerId,
      status: { $in: activeStatuses }
    });
    if (timer) await stopTimer(timer);

    task.status = 'Done';
    await task.save();

    res.json({ task, timer: serializeTimer(timer) });
  } catch (err) {
    next(err);
  }
});

router.get('/tasks/:taskId/history', protect, attachWorkspace, async (req, res, next) => {
  try {
    if (!isValidTaskId(req.params.taskId)) {
      return res.status(400).json({ error: 'Invalid task id.' });
    }
    const task = await Task.findOne(taskVisibilityFilter(req.workspace, { _id: req.params.taskId })).lean();
    if (!task) return res.status(404).json({ error: 'Task not found.' });

    const sessions = await TaskTimer.find({
      taskId: task._id,
      workspaceId: req.workspace.ownerId
    }).sort({ createdAt: 1 }).lean();
    const extensions = await TimerExtension.find({
      taskId: task._id,
      workspaceId: req.workspace.ownerId
    }).sort({ createdAt: 1 }).lean();

    const serializedSessions = sessions.map(serializeTimer);
    const actualSeconds = serializedSessions.reduce((sum, session) => sum + (session.elapsedSeconds || session.durationSeconds || 0), 0);
    const extraMinutesAdded = extensions.reduce((sum, extension) => sum + (extension.addedMinutes || 0), 0);
    const estimatedMinutes = task.estimatedMinutes || 30;
    const actualMinutes = Math.round(actualSeconds / 60);

    res.json({
      estimatedMinutes,
      actualSeconds,
      actualMinutes,
      differenceMinutes: actualMinutes - estimatedMinutes,
      extraMinutesAdded,
      sessionCount: sessions.length,
      sessions: serializedSessions,
      extensions
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
