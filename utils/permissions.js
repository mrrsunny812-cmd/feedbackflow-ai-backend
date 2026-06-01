const WorkspaceMember = require('../models/WorkspaceMember');

const ROLE = {
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  DEVELOPER: 'Developer',
  DESIGNER: 'Designer',
  VIEWER: 'Viewer'
};

const isAdmin = (member) => member?.role === ROLE.ADMIN;
const isManager = (member) => member?.role === ROLE.MANAGER;
const canManageMembers = () => false;
const canInviteMembers = () => false;
const canAssignTasks = () => false;
const canViewAllTasks = () => true;
const canEditTasks = () => true;
const canStartTimer = (member) => !!member && member.role !== ROLE.VIEWER;

const ensureOwnerMember = async (user) => {
  let member = await WorkspaceMember.findOne({ ownerId: user._id, email: user.email });
  if (!member) {
    member = await WorkspaceMember.create({
      ownerId: user._id,
      userId: user._id,
      name: user.name,
      email: user.email,
      role: ROLE.ADMIN,
      status: 'active',
      invitedBy: user._id,
      joinedAt: new Date()
    });
  }
  return member;
};

const getWorkspaceContext = async (user) => {
  let member = await WorkspaceMember.findOne({
    userId: user._id,
    status: 'active'
  }).sort({ createdAt: 1 });

  if (!member) {
    member = await WorkspaceMember.findOne({
      email: user.email,
      status: 'active'
    }).sort({ createdAt: 1 });
  }

  if (!member) {
    member = await ensureOwnerMember(user);
  }

  return {
    workspaceId: member.ownerId,
    ownerId: member.ownerId,
    member,
    role: member.role,
    permissions: {
      isAdmin: isAdmin(member),
      isManager: isManager(member),
      canManageMembers: canManageMembers(member),
      canInviteMembers: canInviteMembers(member),
      canAssignTasks: canAssignTasks(member),
      canViewAllTasks: canViewAllTasks(member),
      canEditTasks: canEditTasks(member)
    }
  };
};

const attachWorkspace = async (req, res, next) => {
  try {
    req.workspace = await getWorkspaceContext(req.user);
    next();
  } catch (err) {
    next(err);
  }
};

const taskVisibilityFilter = (workspace, base = {}) => {
  const filter = { ...base, userId: workspace.ownerId };
  return filter;
};

module.exports = {
  ROLE,
  isAdmin,
  isManager,
  canManageMembers,
  canInviteMembers,
  canAssignTasks,
  canViewAllTasks,
  canEditTasks,
  canStartTimer,
  ensureOwnerMember,
  getWorkspaceContext,
  attachWorkspace,
  taskVisibilityFilter
};
