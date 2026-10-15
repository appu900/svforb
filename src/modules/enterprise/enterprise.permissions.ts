import { ForbiddenException } from '@nestjs/common';
import { EnterpriseRole } from '@prisma/client';

/**
 * What a role is allowed to do, in one place.
 *
 * The Roles & Permissions screen reads from this table and so does every
 * request guard, which is the point: the screen cannot drift from the rules
 * that actually gate requests, because there is only one set of rules.
 */
export const PERMISSION = {
  STRUCTURE_VIEW: 'structure.view',
  /** Create a new Group, Cluster or Territory. */
  STRUCTURE_CREATE: 'structure.create',
  /** Rename, deactivate, and assign sites into an existing structure. */
  STRUCTURE_MANAGE: 'structure.manage',
  /** Permanent deletion, only ever possible where no history exists. */
  STRUCTURE_DELETE: 'structure.delete',

  SITES_VIEW: 'sites.view',
  SITES_MANAGE: 'sites.manage',

  USERS_VIEW: 'users.view',
  USERS_MANAGE: 'users.manage',

  REPORTS_VIEW: 'reports.view',
  PROFILE_MANAGE: 'profile.manage',
  AUDIT_VIEW: 'audit.view',
} as const;

export type EnterprisePermission = (typeof PERMISSION)[keyof typeof PERMISSION];

export interface RoleDefinition {
  role: EnterpriseRole;
  label: string;
  /** The one-line reach description from Roles & Permissions (page 17). */
  description: string;
  permissions: readonly EnterprisePermission[];
  /** Roles a holder of this role may grant to somebody else. */
  assignable: readonly EnterpriseRole[];
  /**
   * True when the role means nothing without an explicit scope grant. A
   * Site Admin with no scope sees nothing, which is the safe default —
   * whereas an Enterprise Admin covers everything by definition.
   */
  requiresScope: boolean;
  /** Retained for existing rows; never offered in the portal. */
  legacy?: true;
}

const ALL: readonly EnterprisePermission[] = Object.values(PERMISSION);

/**
 * The four roles the Enterprise Portal defines, in the order the screen lists
 * them — broadest reach first.
 */
export const PORTAL_ROLES: readonly EnterpriseRole[] = [
  EnterpriseRole.SUPER_ADMIN,
  EnterpriseRole.ENTERPRISE_ADMIN,
  EnterpriseRole.GROUP_ADMIN,
  EnterpriseRole.SITE_ADMIN,
];

export const ROLE_DEFINITIONS: Record<EnterpriseRole, RoleDefinition> = {
  [EnterpriseRole.SUPER_ADMIN]: {
    role: EnterpriseRole.SUPER_ADMIN,
    label: 'Enterprise Super Admin',
    description: 'Full administration across the Enterprise.',
    permissions: ALL,
    assignable: PORTAL_ROLES,
    requiresScope: false,
  },

  // Head-office visibility: every site and report across the Enterprise, but
  // nothing can be added, edited or removed.
  [EnterpriseRole.ENTERPRISE_ADMIN]: {
    role: EnterpriseRole.ENTERPRISE_ADMIN,
    label: 'Enterprise Admin (View only)',
    description:
      'View everything across the Enterprise — dashboard, all sites, activity, insights and reports. Cannot add, edit or change anything.',
    permissions: [
      PERMISSION.STRUCTURE_VIEW,
      PERMISSION.SITES_VIEW,
      PERMISSION.USERS_VIEW,
      PERMISSION.REPORTS_VIEW,
      PERMISSION.AUDIT_VIEW,
    ],
    assignable: [],
    requiresScope: false,
  },

  [EnterpriseRole.GROUP_ADMIN]: {
    role: EnterpriseRole.GROUP_ADMIN,
    label: 'Group Admin',
    description:
      'Administration within assigned scope — one or more Groups, Territories or Clusters.',
    // No STRUCTURE_CREATE: new dimensions are an Enterprise-wide decision, and
    // no STRUCTURE_DELETE, which is irreversible. Everything else is theirs to
    // manage, but only inside their own scope.
    permissions: [
      PERMISSION.STRUCTURE_VIEW,
      PERMISSION.STRUCTURE_MANAGE,
      PERMISSION.SITES_VIEW,
      PERMISSION.SITES_MANAGE,
      PERMISSION.USERS_VIEW,
      PERMISSION.USERS_MANAGE,
      PERMISSION.REPORTS_VIEW,
      PERMISSION.AUDIT_VIEW,
    ],
    assignable: [EnterpriseRole.SITE_ADMIN],
    requiresScope: true,
  },

  [EnterpriseRole.SITE_ADMIN]: {
    role: EnterpriseRole.SITE_ADMIN,
    label: 'Site Admin',
    description: 'Operational administration for assigned sites.',
    permissions: [
      PERMISSION.STRUCTURE_VIEW,
      PERMISSION.SITES_VIEW,
      PERMISSION.SITES_MANAGE,
      PERMISSION.REPORTS_VIEW,
    ],
    assignable: [],
    requiresScope: true,
  },

  // ─── Legacy ────────────────────────────────────────────────────────────────
  // Rows created before the portal defined its roles. They keep working; the
  // portal neither offers nor accepts them.

  [EnterpriseRole.CLUSTER_ADMIN]: {
    role: EnterpriseRole.CLUSTER_ADMIN,
    label: 'Cluster Admin',
    description: 'Legacy role. Treated as a Group Admin scoped to their clusters.',
    permissions: [
      PERMISSION.STRUCTURE_VIEW,
      PERMISSION.SITES_VIEW,
      PERMISSION.SITES_MANAGE,
      PERMISSION.REPORTS_VIEW,
    ],
    assignable: [],
    requiresScope: true,
    legacy: true,
  },

  [EnterpriseRole.SITE_USER]: {
    role: EnterpriseRole.SITE_USER,
    label: 'Site User',
    description: 'Legacy role. Operational access to their own sites only.',
    permissions: [PERMISSION.SITES_VIEW, PERMISSION.REPORTS_VIEW],
    assignable: [],
    requiresScope: true,
    legacy: true,
  },
};

/**
 * Roles that can see what is in reach but must never create, edit or cancel
 * anything — including listings, which are otherwise open to any member.
 */
const VIEW_ONLY_ROLES: readonly EnterpriseRole[] = [EnterpriseRole.ENTERPRISE_ADMIN];

export function isViewOnlyRole(role: EnterpriseRole | null | undefined): boolean {
  return Boolean(role && VIEW_ONLY_ROLES.includes(role));
}

export function assertNotViewOnly(caller: { enterpriseRole?: EnterpriseRole | null }) {
  if (isViewOnlyRole(caller.enterpriseRole)) {
    throw new ForbiddenException('Your role is view only. Ask an Enterprise Super Admin to make this change.');
  }
}

export function isPortalRole(role: EnterpriseRole): boolean {
  return !ROLE_DEFINITIONS[role]?.legacy;
}

export function roleLabel(role: EnterpriseRole): string {
  return ROLE_DEFINITIONS[role]?.label ?? role;
}

export function permissionsFor(role: EnterpriseRole): readonly EnterprisePermission[] {
  return ROLE_DEFINITIONS[role]?.permissions ?? [];
}

export function roleHasPermission(
  role: EnterpriseRole | null | undefined,
  permission: EnterprisePermission,
): boolean {
  if (!role) return false;
  return permissionsFor(role).includes(permission);
}

/** The roles this role may grant. Empty for everyone who cannot manage users. */
export function assignableRolesFor(
  role: EnterpriseRole | null | undefined,
): readonly EnterpriseRole[] {
  if (!role) return [];
  return ROLE_DEFINITIONS[role]?.assignable ?? [];
}

/**
 * Whether a role's reach is the whole Enterprise regardless of UserScope rows.
 * The inverse of `requiresScope`, named for how the callers read.
 */
export function isUnrestricted(role: EnterpriseRole | null | undefined): boolean {
  if (!role) return false;
  return !ROLE_DEFINITIONS[role].requiresScope;
}

/** Backs GET /enterprise/roles — the same table the guards read. */
export function rolesMatrix() {
  return {
    permissions: Object.values(PERMISSION),
    roles: PORTAL_ROLES.map((role) => {
      const def = ROLE_DEFINITIONS[role];
      return {
        role,
        label: def.label,
        description: def.description,
        requiresScope: def.requiresScope,
        permissions: def.permissions,
        canAssign: def.assignable,
      };
    }),
  };
}
