const Activity = require('../models/Activity');

const recordActivity = async ({ ownerId, actorId, type, taskId = null, memberId = null, message, metadata = {} }) => {
  try {
    await Activity.create({ ownerId, actorId, type, taskId, memberId, message, metadata });
  } catch (err) {
    console.error('Failed to record activity:', err.message);
  }
};

module.exports = { recordActivity };
