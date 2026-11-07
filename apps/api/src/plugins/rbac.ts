// Session 37: the real logic moved to services/authorizationService.ts
// (ADMIN_BUILD_GUIDE.md §1's "consolidate hasPermission/rbac.ts into one
// authorizationService.ts") so Super Admin/group-read code (isPlatformAdmin,
// canReadOrg, withAuthorizedOrgContext) lives next to the checks it
// extends rather than in a file named for one specific check. Kept as a
// re-export, not deleted, so every existing route's
// `from '../plugins/rbac.js'` import keeps working unchanged.
export {
  hasPermission,
  requirePermission,
  type PermissionAction,
} from '../services/authorizationService.js';
