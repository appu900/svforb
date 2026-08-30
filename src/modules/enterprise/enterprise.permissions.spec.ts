import { EnterpriseRole } from '@prisma/client';
import {
  assignableRolesFor,
  isPortalRole,
  isUnrestricted,
  PERMISSION,
  PORTAL_ROLES,
  roleHasPermission,
  rolesMatrix,
} from './enterprise.permissions';

describe('Enterprise role matrix', () => {
  describe('the portal defines five roles', () => {
    it('offers exactly the five from Roles & Permissions', () => {
      expect(PORTAL_ROLES).toEqual([
        EnterpriseRole.SUPER_ADMIN,
        EnterpriseRole.ENTERPRISE_ADMIN,
        EnterpriseRole.GROUP_ADMIN,
        EnterpriseRole.REPORTING_USER,
        EnterpriseRole.SITE_ADMIN,
      ]);
    });

    it('treats the two pre-portal roles as legacy', () => {
      expect(isPortalRole(EnterpriseRole.CLUSTER_ADMIN)).toBe(false);
      expect(isPortalRole(EnterpriseRole.SITE_USER)).toBe(false);
    });

    it('never offers a legacy role for assignment', () => {
      for (const role of Object.values(EnterpriseRole)) {
        expect(assignableRolesFor(role)).not.toContain(EnterpriseRole.CLUSTER_ADMIN);
        expect(assignableRolesFor(role)).not.toContain(EnterpriseRole.SITE_USER);
      }
    });
  });

  describe('nobody may grant a role above their own', () => {
    it('lets only a Super Admin mint another Super Admin', () => {
      const minters = Object.values(EnterpriseRole).filter((role) =>
        assignableRolesFor(role).includes(EnterpriseRole.SUPER_ADMIN),
      );
      expect(minters).toEqual([EnterpriseRole.SUPER_ADMIN]);
    });

    // The hand-written check this replaced fell through to "allow" here.
    it('stops a Group Admin granting Enterprise Admin', () => {
      expect(assignableRolesFor(EnterpriseRole.GROUP_ADMIN)).not.toContain(
        EnterpriseRole.ENTERPRISE_ADMIN,
      );
    });

    it('stops a Group Admin minting another Group Admin', () => {
      expect(assignableRolesFor(EnterpriseRole.GROUP_ADMIN)).not.toContain(
        EnterpriseRole.GROUP_ADMIN,
      );
    });

    it('leaves a Group Admin able to staff their own scope', () => {
      expect(assignableRolesFor(EnterpriseRole.GROUP_ADMIN)).toEqual([
        EnterpriseRole.REPORTING_USER,
        EnterpriseRole.SITE_ADMIN,
      ]);
    });

    it('gives roles that cannot manage users nothing to assign', () => {
      expect(assignableRolesFor(EnterpriseRole.REPORTING_USER)).toEqual([]);
      expect(assignableRolesFor(EnterpriseRole.SITE_ADMIN)).toEqual([]);
      expect(assignableRolesFor(null)).toEqual([]);
    });
  });

  describe('reach', () => {
    it('covers the whole Enterprise for the two administrator roles', () => {
      expect(isUnrestricted(EnterpriseRole.SUPER_ADMIN)).toBe(true);
      expect(isUnrestricted(EnterpriseRole.ENTERPRISE_ADMIN)).toBe(true);
    });

    it('requires a scope grant for everyone else', () => {
      expect(isUnrestricted(EnterpriseRole.GROUP_ADMIN)).toBe(false);
      expect(isUnrestricted(EnterpriseRole.REPORTING_USER)).toBe(false);
      expect(isUnrestricted(EnterpriseRole.SITE_ADMIN)).toBe(false);
    });

    it('treats an unknown caller as having no reach', () => {
      expect(isUnrestricted(null)).toBe(false);
    });
  });

  describe('structure permissions', () => {
    it('lets a Group Admin manage structures but not create or delete them', () => {
      expect(
        roleHasPermission(EnterpriseRole.GROUP_ADMIN, PERMISSION.STRUCTURE_MANAGE),
      ).toBe(true);
      expect(
        roleHasPermission(EnterpriseRole.GROUP_ADMIN, PERMISSION.STRUCTURE_CREATE),
      ).toBe(false);
      expect(
        roleHasPermission(EnterpriseRole.GROUP_ADMIN, PERMISSION.STRUCTURE_DELETE),
      ).toBe(false);
    });

    it('keeps a Reporting User read-only', () => {
      expect(
        roleHasPermission(EnterpriseRole.REPORTING_USER, PERMISSION.STRUCTURE_VIEW),
      ).toBe(true);
      for (const write of [
        PERMISSION.STRUCTURE_CREATE,
        PERMISSION.STRUCTURE_MANAGE,
        PERMISSION.STRUCTURE_DELETE,
        PERMISSION.SITES_MANAGE,
        PERMISSION.USERS_MANAGE,
        PERMISSION.PROFILE_MANAGE,
      ]) {
        expect(roleHasPermission(EnterpriseRole.REPORTING_USER, write)).toBe(false);
      }
    });

    it('does not let a Site Admin manage users', () => {
      expect(roleHasPermission(EnterpriseRole.SITE_ADMIN, PERMISSION.USERS_MANAGE)).toBe(
        false,
      );
    });

    it('grants a Super Admin everything', () => {
      for (const permission of Object.values(PERMISSION)) {
        expect(roleHasPermission(EnterpriseRole.SUPER_ADMIN, permission)).toBe(true);
      }
    });

    it('refuses a caller with no role', () => {
      expect(roleHasPermission(null, PERMISSION.STRUCTURE_VIEW)).toBe(false);
      expect(roleHasPermission(undefined, PERMISSION.REPORTS_VIEW)).toBe(false);
    });
  });

  describe('the screen and the guards read the same table', () => {
    it('publishes one row per portal role and no legacy ones', () => {
      const matrix = rolesMatrix();
      expect(matrix.roles.map((r) => r.role)).toEqual(PORTAL_ROLES);
    });

    it('publishes permissions that match what the guards enforce', () => {
      for (const row of rolesMatrix().roles) {
        for (const permission of Object.values(PERMISSION)) {
          expect(row.permissions.includes(permission)).toBe(
            roleHasPermission(row.role, permission),
          );
        }
      }
    });

    it('publishes the same assignable roles the guards allow', () => {
      for (const row of rolesMatrix().roles) {
        expect(row.canAssign).toEqual(assignableRolesFor(row.role));
      }
    });
  });
});
