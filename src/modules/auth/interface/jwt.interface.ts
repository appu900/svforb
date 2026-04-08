import { OrgRole, OrgType, PlatformRole, SiteRole } from '@prisma/client';

export interface Jwtpayload {
  sub: number;
  email: string;
  platformRole: PlatformRole;
  orgId?: number;
  orgType?: OrgType;
  orgRole?: OrgRole;
  siteId?: number;
  siteRole?: SiteRole;
}

export interface AuthToken {
    accessToken:string;
    expiresIn:number;
}
