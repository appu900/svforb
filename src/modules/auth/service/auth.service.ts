import {
  Logger,
  Injectable,
  ConflictException,
  ForbiddenException,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AuthCacheManager } from '../cache/auth.cache.manager';
import {
  ForgotPasswordDto,
  LoginDto,
  RegisterBusinessDto,
  RegisterCharityDto,
  RegisterPlatformAdminDto,
  ResetPasswordDto,
  VerifyEmailOtpDto,
} from '../dto/auth.dto';
import {
  Organisation,
  OrgMemeberShip,
  OrgRole,
  OrgType,
  PlatformRole,
  Prisma,
  SiteRole,
  SubscriptionStatus,
  User,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { S3Service } from 'src/uploads/s3/s3.service';
import { AuthToken, Jwtpayload } from '../interface/jwt.interface';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { EmailQueueService } from 'src/modules/notifications/queues/email.queue.service';

function GenerateOtp() {
  const buf = randomBytes(3);
  const num = (((buf[0] << 16) | (buf[1] << 8) | buf[2]) % 900000) + 100000;
  return num.toString();
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private IMAGE_UPLOAD_FILE_NAME = 'buisiness2logo';
  constructor(
    private readonly prisma: PrismaService,
    private authCacheManaher: AuthCacheManager,
    private readonly s3: S3Service,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly emailService: EmailQueueService,
  ) {}

  async registerBusiness(dto: RegisterBusinessDto, logo?: Express.Multer.File) {
    await this.assertEmailUnique(dto.email);
    const trialPlan = await this.prisma.subscriptionPlan.findFirst({
      where: { name: 'FREE_TRIAL', isActive: true },
    });
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const verifyToken = randomBytes(32).toString('hex');
    const verifyExpiery = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const otp = GenerateOtp();

    let uploadLogoUrl = '';
    if (logo) {
      uploadLogoUrl = await this.s3.uploadFile(
        logo,
        this.IMAGE_UPLOAD_FILE_NAME,
      );
      this.logger.log('file uploaded to s3', uploadLogoUrl);
    }

    /**
     * Transction will contain
     * 1. create user
     * 2. create organisation
     * 3. create organisation membership
     * 4. for single buisness grant admin access
     *
     */
    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          firstName: dto.firstName,
          lastName: dto.lastName,
          email: dto.email,
          passwordHash,
          phoneNumber: dto.mobile,
          platformRole: PlatformRole.ORG_USER,
          emailverifyToken: verifyToken,
          emailVerifyExpiry: verifyExpiery,
        },
      });

      const org = await tx.organisation.create({
        data: {
          name: dto.businessName,
          address: dto.businessAddress,
          organizationType: dto.orgType,
          registrationNumber: dto.registrationNumber,
          venueType: dto.venueType,
          subscriptionId: trialPlan!.id,
          subscriptionStatus: SubscriptionStatus.TRIALING,
          brandName: dto.brandName ?? '',
          trialEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          latitude:dto.latitude,
          longitude:dto.longitude,
          logoUrl: uploadLogoUrl,
        },
      });

      await tx.orgMemeberShip.create({
        data: {
          userId: user.id,
          organisationId: org.id,
          orgRole: OrgRole.SUPER_ADMIN,
        },
      });

      if (dto.orgType === OrgType.BUSINESS_SINGLE) {
        const site = await tx.site.create({
          data: {
            organisationId: org.id,
            address: dto.businessAddress,
            contactName: `${dto.firstName} ${dto.lastName}`,
            contactEmail: dto.email ?? '',
            latitude: dto.latitude,
            longitude: dto.longitude,
            contactMobile: dto.mobile ?? '',
            organisationName: dto.businessName,
          },
        });

        await tx.siteAccess.create({
          data: {
            userId: user.id,
            siteId: site.id,
            organisationId: org.id,
            siteRole: SiteRole.SITE_ADMIN,
            grantedBy: user.id,
          },
        });
      }
      return { user, org };
    });

    // cache functions
    await this.emailService.sendOtp({
      to: dto.email,
      otp: otp.toString(),
      name: dto.firstName,
    });
    await this.authCacheManaher.storeEmailVerificationOtp(dto.email, otp);
    this.logger.log(
      `Business registered : ${dto.email} org=${result.org.name}`,
    );

    return {
      message: 'Account created , Check your inbox to verify your email',
    };
  }

  async registerCharity(dto: RegisterCharityDto, logo?: Express.Multer.File) {
    if (
      dto.charityType !== OrgType.CHARITY_SINGLE &&
      dto.charityType !== OrgType.CHARITY_MULTI
    ) {
      throw new BadRequestException('charityType must be CHARITY_SINGLE or CHARITY_MULTI');
    }

    if (dto.charityType === OrgType.CHARITY_SINGLE && !dto.pickupPostCode) {
      throw new BadRequestException('pickupPostCode is required for single-location charities');
    }

    await this.assertEmailUnique(dto.email);
    const trialPlan = await this.prisma.subscriptionPlan.findFirst({
      where: { name: 'FREE_TRIAL', isActive: true },
    });
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const otp = GenerateOtp();

    let uploadedLogoUrl = '';
    if (logo) {
      uploadedLogoUrl = await this.s3.uploadFile(logo, this.IMAGE_UPLOAD_FILE_NAME);
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          firstName: dto.firstName,
          lastName: dto.lastName,
          email: dto.email.toLowerCase(),
          passwordHash,
          phoneNumber: dto.mobile ?? '',
          platformRole: PlatformRole.ORG_USER,
        },
      });

      const org = await tx.organisation.create({
        data: {
          name: dto.charityName,
          organizationType: dto.charityType,
          address: dto.charityAddress,
          registrationNumber: dto.registrationNumber,
          brandName: dto.brandName,
          subscriptionId: trialPlan!.id,
          subscriptionStatus: SubscriptionStatus.ACTIVE,
          trialEndsAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
          latitude: dto.latitude,
          longitude: dto.longitude,
          logoUrl: uploadedLogoUrl,
        },
      });

      await tx.orgMemeberShip.create({
        data: {
          userId: user.id,
          organisationId: org.id,
          orgRole: OrgRole.SUPER_ADMIN,
        },
      });

      if (dto.charityType === OrgType.CHARITY_SINGLE) {
        const site = await tx.site.create({
          data: {
            organisationId: org.id,
            organisationName: dto.charityName,
            address: dto.charityAddress,
            postcode: dto.pickupPostCode ?? '',
            contactName: `${dto.firstName} ${dto.lastName}`,
            contactEmail: dto.email.toLowerCase(),
            contactMobile: dto.mobile ?? '',
            latitude: dto.latitude,
            longitude: dto.longitude,
            pickupRadiusKm: dto.pickupRadiusKm ?? 5,
          },
        });

        await tx.siteAccess.create({
          data: {
            userId: user.id,
            siteId: site.id,
            organisationId: org.id,
            siteRole: SiteRole.SITE_ADMIN,
            grantedBy: user.id,
          },
        });

        await tx.charityPickupPrefs.create({
          data: {
            organisationId: org.id,
            postCode: dto.pickupPostCode!,
            radiusKm: dto.pickupRadiusKm ?? 5,
          },
        });
      }

      return { user, org };
    });

    await this.emailService.sendOtp({
      to: dto.email,
      otp: otp.toString(),
      name: dto.firstName,
    });
    await this.authCacheManaher.storeEmailVerificationOtp(dto.email, otp);

    this.logger.log(
      `Charity registered: ${dto.email} type=${dto.charityType} org=${result.org.name}`,
    );

    return {
      message: 'Account created, check your inbox to verify your email',
    };
  }

  async login(dto: LoginDto) {
    const currentLoginAttempts =
      await this.authCacheManaher.incrementLoginattempts(dto.email);
    if (currentLoginAttempts > 5) {
      throw new ForbiddenException(
        'Too many login attepmts, Try again after 15 Minutes',
      );
    }
    const user = await this.prisma.user.findUnique({
      where: {
        email: dto.email.toLowerCase(),
      },
    });
    if (!user || !user.isActive)
      throw new UnauthorizedException('User not found');
    const passwordMatch = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordMatch) throw new UnauthorizedException('Invalid Credentials');
    if (!user.emailVerified)
      throw new ForbiddenException(
        'Please verufy your email before loggging in',
      );

    await this.authCacheManaher.clearLoginAttempts(dto.email);

    // Platform admins have no org membership — issue token directly
    if (user.platformRole === PlatformRole.PLATFORM_ADMIN) {
      const accessToken = await this.generateTokens(user);
      this.logger.log(`Platform admin logged in: ${user.email}`);
      return {
        accessToken,
        user: {
          id: user.id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          platformRole: user.platformRole,
        },
      };
    }

    const memberShip = await this.prisma.orgMemeberShip.findFirst({
      where: { userId: user.id },
      include: { organisation: { include: { subscription: true } } },
    });
    if (!memberShip)
      throw new UnauthorizedException('No organisation found for this user');

    const organisationId = memberShip.organisationId;
    let primarySiteAccess:
      | {
          siteId: number;
          siteRole: SiteRole;
          siteName: string;
          address: string;
        }
      | undefined;
    const access = await this.prisma.siteAccess.findFirst({
      where: { userId: user.id, organisationId },
      include: {
        site: { select: { organisationName: true, address: true } },
      },
      orderBy: { grantedAt: 'asc' },
    });
    if (access) {
      primarySiteAccess = {
        siteId: access.siteId,
        siteRole: access.siteRole,
        siteName: access.site.organisationName,
        address: access.site.address,
      };
    }

    const accessToken = await this.generateTokens(user, memberShip, primarySiteAccess);

    return {
      accessToken,
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        platformRole: user.platformRole,
      },
      siteAccess: primarySiteAccess,
    };
  }

  private async generateTokens(
    user: User,
    membership?: any,
    siteAccess?: {
      siteId: number;
      siteRole: SiteRole;
      siteName: string;
      address: string;
    },
  ): Promise<string> {
    const payload: Jwtpayload = {
      sub: user.id,
      email: user.email,
      platformRole: user.platformRole,
      orgId: membership?.organisationId,
      orgRole: membership?.orgRole,
      siteId: siteAccess?.siteId,
      siteRole: siteAccess?.siteRole,
      orgType: membership?.organisation?.organizationType,
    };
    const accessToken = await this.jwtService.sign(payload);
    return accessToken;
  }

  async verifyEmail(dto: VerifyEmailOtpDto) {
    const cachedOtp = await this.authCacheManaher.getEmailVerifyOtp(dto.email);
    if (!cachedOtp) {
      throw new BadRequestException('OTP has expired, please request a new one');
    }
    if (cachedOtp !== dto.otp) {
      throw new BadRequestException('Invalid OTP');
    }

    const user = await this.prisma.user.update({
      where: { email: dto.email.toLowerCase() },
      data: { emailVerified: true, emailverifyToken: null, emailVerifyExpiry: null },
    });

    await this.authCacheManaher.revokeEmailVerifyOtp(dto.email);

    const membership = await this.prisma.orgMemeberShip.findFirst({
      where: { userId: user.id },
      include: { organisation: { include: { subscription: true } } },
    });
    if (!membership) {
      throw new UnauthorizedException('No organisation found for this user');
    }

    const access = await this.prisma.siteAccess.findFirst({
      where: { userId: user.id, organisationId: membership.organisationId },
      include: { site: { select: { organisationName: true, address: true } } },
      orderBy: { grantedAt: 'asc' },
    });

    const siteAccess = access
      ? {
          siteId: access.siteId,
          siteRole: access.siteRole,
          siteName: access.site.organisationName,
          address: access.site.address,
        }
      : undefined;

    const accessToken = await this.generateTokens(user, membership, siteAccess);

    this.logger.log(`Email verified and auto-logged in: ${user.email}`);

    return {
      message: 'Email verified successfully',
      accessToken,
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
      },
    };
  }

  async registerPlatformAdmin(dto: RegisterPlatformAdminDto) {
    await this.assertEmailUnique(dto.email);
    const passwordHash = await bcrypt.hash(dto.password, 10);
    

    const user = await this.prisma.user.create({
      data: {
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email.toLowerCase(),
        passwordHash,
        platformRole: PlatformRole.PLATFORM_ADMIN,
        emailVerified: true,
        phoneNumber: '',
      },
    });

    this.logger.log(`Platform admin registered: ${user.email}`);

    return {
      message: 'Platform admin account created successfully',
      userId: user.id,
    };
  }

  async getProfile(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phoneNumber: true,
        platformRole: true,
        createdAt: true,
      },
    });
    if (!user) throw new UnauthorizedException('User not found');

    if (user.platformRole === PlatformRole.PLATFORM_ADMIN) {
      return {
        user: {
          id: user.id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          phoneNumber: user.phoneNumber,
          platformRole: user.platformRole,
          memberSince: user.createdAt.getFullYear(),
        },
        organisation: null,
        role: { platformRole: user.platformRole, orgRole: null, siteRole: null },
        subscription: null,
        sites: [],
      };
    }

    const membership = await this.prisma.orgMemeberShip.findFirst({
      where: { userId: user.id },
      include: {
        organisation: {
          include: { subscription: true },
        },
      },
    });
    if (!membership) throw new UnauthorizedException('No organisation found for this user');

    const { organisation } = membership;

    const siteAccesses = await this.prisma.siteAccess.findMany({
      where: { userId: user.id, organisationId: organisation.id },
      include: {
        site: {
          select: {
            id: true,
            organisationName: true,
            address: true,
            postcode: true,
            contactEmail: true,
            contactMobile: true,
            isActive: true,
          },
        },
      },
      orderBy: { grantedAt: 'asc' },
    });

    const { subscription } = organisation;

    return {
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phoneNumber: user.phoneNumber,
        platformRole: user.platformRole,
        memberSince: membership.joinedAt.getFullYear(),
      },
      organisation: {
        id: organisation.id,
        name: organisation.name,
        type: organisation.organizationType,
        registrationNumber: organisation.registrationNumber,
        address: organisation.address,
        brandName: organisation.brandName,
        venueType: organisation.venueType,
        logoUrl: organisation.logoUrl,
        region: organisation.region,
        latitude: organisation.latitude,
        longitude: organisation.longitude,
        ratingAvg: organisation.ratingAvg,
        ratingCount: organisation.ratingCount,
        createdAt: organisation.createdAt,
      },
      role: {
        platformRole: user.platformRole,
        orgRole: membership.orgRole,
        siteRole: siteAccesses[0]?.siteRole ?? null,
      },
      subscription: subscription
        ? {
            plan: {
              name: subscription.name,
              displayName: subscription.displayName,
              priceMonthly: subscription.priceMonthly,
              priceAnnual: subscription.priceAnnual,
              features: subscription.features,
              maxSites: subscription.maxSites,
              maxUsersPerSite: subscription.maxUserPerSite,
            },
            status: organisation.subscriptionStatus,
            billingCycle: organisation.billingCycle,
            trialEndsAt: organisation.trialEndsAt,
            currentPeriodEnd: organisation.currentPeriodEnd,
          }
        : null,
      sites: siteAccesses.map((sa) => ({
        id: sa.site.id,
        name: sa.site.organisationName,
        address: sa.site.address,
        postcode: sa.site.postcode,
        contactEmail: sa.site.contactEmail,
        contactMobile: sa.site.contactMobile,
        isActive: sa.site.isActive,
        siteRole: sa.siteRole,
        grantedAt: sa.grantedAt,
      })),
    };
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    // Always return success to avoid leaking whether the email exists
    if (!user || !user.isActive) {
      return { message: 'If that email is registered, a reset code has been sent.' };
    }

    const otp = GenerateOtp();
    await this.authCacheManaher.storePasswordResetOtp(dto.email.toLowerCase(), otp);

    await this.emailService.sendPasswordReset({
      to: dto.email,
      resetToken: otp,
      name: user.firstName,
    });

    this.logger.log(`Password reset OTP sent: ${dto.email}`);
    return { message: 'If that email is registered, a reset code has been sent.' };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const cachedOtp = await this.authCacheManaher.getPasswordResetOtp(
      dto.email.toLowerCase(),
    );

    if (!cachedOtp) {
      throw new BadRequestException('Reset code has expired. Please request a new one.');
    }
    if (cachedOtp !== dto.otp) {
      throw new BadRequestException('Invalid reset code.');
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, 10);

    await this.prisma.user.update({
      where: { email: dto.email.toLowerCase() },
      data: { passwordHash },
    });

    await this.authCacheManaher.revokePasswordResetOtp(dto.email.toLowerCase());

    this.logger.log(`Password reset successful: ${dto.email}`);
    return { message: 'Password has been reset successfully. You can now log in.' };
  }

  private async assertEmailUnique(email: string) {
    const existing = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });
    if (existing)
      throw new ConflictException('An account with this email already exists');
  }

  private async ensureUserUnique(email: string, phoneNumber: string) {
    const [userExistsByEmail, userExistsByPhone] = await Promise.all([
      await this.prisma.user.findUnique({ where: { email } }),
      await this.prisma.user.findFirst({ where: { phoneNumber } }),
    ]);
  }
}
