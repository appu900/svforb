import {
  Logger,
  Injectable,
  ConflictException,
  ForbiddenException,
  BadRequestException,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';
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
  User,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { S3Service } from '../../../uploads/s3/s3.service';
import { AuthToken, Jwtpayload } from '../interface/jwt.interface';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { EmailQueueService } from '../../../modules/notifications/queues/email.queue.service';
import { ProximityService } from '../../../modules/psearch/psearch.service';
import { RegisterFarmerConsumerDto } from '../dto/register.farmer.consumer.dto';
import { RegisterFarmerProducerDto } from '../dto/register.farmer.producer.dto';
import { RedisGeoSearchService } from '../../../modules/redis-geo-search/redis.geosearch.service';

const PROFILE_BUSINESS_TYPES: OrgType[] = [
  OrgType.BUSINESS_SINGLE,
  OrgType.BUSINESS_MULTI,
  OrgType.FARMER_PRODUCER,
];
const PROFILE_CHARITY_TYPES: OrgType[] = [
  OrgType.CHARITY,
  OrgType.CHARITY_SINGLE,
  OrgType.CHARITY_MULTI,
];

function GenerateOtp() {
  const buf = randomBytes(3);
  const num = (((buf[0] << 16) | (buf[1] << 8) | buf[2]) % 900000) + 100000;
  return num.toString();
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
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
    private readonly proximityService: ProximityService,
    private readonly geoSearch: RedisGeoSearchService,
  ) {}

  async registerBusiness(dto: RegisterBusinessDto, logo?: Express.Multer.File) {
    const email = normalizeEmail(dto.email);
    await this.assertEmailUnique(email);
    // No subscription at signup — businesses pick a plan afterwards.
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
    let result: { user: User; org: Organisation };
    try {
      result = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            firstName: dto.firstName,
            lastName: dto.lastName,
            email,
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
            brandName: dto.brandName ?? '',
            latitude: dto.latitude,
            longitude: dto.longitude,
            region: dto.region,
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
              contactEmail: email,
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
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('An account with this email already exists');
      }
      throw error;
    }

    await this.authCacheManaher.storeEmailVerificationOtp(email, otp);
    await Promise.all([
      this.geoSearch.indexBusiness(
        result.org.id,
        dto.latitude,
        dto.longitude,
        dto.region,
      ),
      this.emailService.sendOtp({
        to: email,
        otp: otp.toString(),
        name: dto.firstName,
      }),
    ]);
    return {
      message: 'Account created, check your inbox to verify your email',
    };
  }
  
  async registerCharity(dto: RegisterCharityDto, logo?: Express.Multer.File) {
    if (
      dto.charityType !== OrgType.CHARITY_SINGLE &&
      dto.charityType !== OrgType.CHARITY_MULTI
    ) {
      throw new BadRequestException(
        'charityType must be CHARITY_SINGLE or CHARITY_MULTI',
      );
    }

    if (dto.charityType === OrgType.CHARITY_SINGLE && !dto.pickupPostCode) {
      throw new BadRequestException(
        'pickupPostCode is required for single-location charities',
      );
    }

    const email = normalizeEmail(dto.email);
    await this.assertEmailUnique(email);
    // Charities are free for life — no subscription record is ever created.
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const otp = GenerateOtp();

    let uploadedLogoUrl = '';
    if (logo) {
      uploadedLogoUrl = await this.s3.uploadFile(
        logo,
        this.IMAGE_UPLOAD_FILE_NAME,
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          firstName: dto.firstName,
          lastName: dto.lastName,
          email,
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
          latitude: dto.latitude,
          longitude: dto.longitude,
          logoUrl: uploadedLogoUrl,
          region: dto.region,
        },
      });

      await tx.orgMemeberShip.create({
        data: {
          userId: user.id,
          organisationId: org.id,
          orgRole: OrgRole.SUPER_ADMIN,
        },
      });

      // Both single and multi create a first site from the signup address so
      // nearby/claim works immediately (multi HQ is also a real site).
      const site = await tx.site.create({
        data: {
          organisationId: org.id,
          organisationName: dto.charityName,
          address: dto.charityAddress,
          postcode: dto.pickupPostCode ?? '',
          contactName: `${dto.firstName} ${dto.lastName}`,
          contactEmail: email,
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

      if (dto.pickupPostCode) {
        await tx.charityPickupPrefs.create({
          data: {
            organisationId: org.id,
            postCode: dto.pickupPostCode,
            radiusKm: dto.pickupRadiusKm ?? 5,
          },
        });
      }

      return {
        user,
        org,
        site,
      };
    });

    if (dto.region) {
      await this.geoSearch.indexCharity(
        result.org.id,
        dto.latitude!,
        dto.longitude!,
        dto.region,
      );
      if (result.site) {
        await this.geoSearch.indexCharitySite(
          result.site.id,
          dto.latitude!,
          dto.longitude!,
          dto.region,
        );
      }
    }

    if (
      result.site &&
      dto.latitude != null &&
      dto.longitude != null
    ) {
      try {
        await this.proximityService.syncSiteLocation(
          result.site.id,
          dto.latitude,
          dto.longitude,
        );
      } catch (error) {
        this.logger.error(
          `Failed to sync PostGIS location for charity site=${result.site.id}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }

    await this.authCacheManaher.storeEmailVerificationOtp(email, otp);
    await this.emailService.sendOtp({
      to: email,
      otp: otp.toString(),
      name: dto.firstName,
    });
    this.logger.log(
      `Charity registered: ${email} type=${dto.charityType} org=${result.org.name}`,
    );

    return {
      message: 'Account created, check your inbox to verify your email',
    };
  }

  private async prepareFarmerConsumerRegistration(
    dto: RegisterFarmerConsumerDto,
    logo?: Express.Multer.File,
  ): Promise<{
    email: string;
    passwordHash: string;
    otp: string;
    logoUrl: string;
  }> {
    const email = normalizeEmail(dto.email);
    await this.assertEmailUnique(email);
    // Farmer consumers receive food — free for life, no subscription record.
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const logoUrl = logo
      ? await this.s3.uploadFile(logo, this.IMAGE_UPLOAD_FILE_NAME)
      : '';
    const otp = GenerateOtp();
    return { email, passwordHash, otp, logoUrl };
  }

  async registerFarmerConsumer(
    dto: RegisterFarmerConsumerDto,
    logo?: Express.Multer.File,
  ) {
    const { email, passwordHash, otp, logoUrl } =
      await this.prepareFarmerConsumerRegistration(dto, logo);
    const verifyToken = randomBytes(32).toString('hex');
    const verifyExpiery = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          firstName: dto.firstName,
          lastName: dto.lastName,
          email,
          passwordHash,
          phoneNumber: dto.mobile ?? '',
          platformRole: PlatformRole.ORG_USER,
          emailverifyToken: verifyToken,
          emailVerifyExpiry: verifyExpiery,
        },
      });
      const org = await tx.organisation.create({
        data: {
          name: dto.businessName,
          address: dto.address,
          organizationType: OrgType.FARMER_CONSUMER,
          venueType: dto.venueType,
          brandName: dto.brandName ?? '',
          latitude: dto.latitude,
          longitude: dto.longitude,
          region: dto.region,
          logoUrl: logoUrl,
        },
      });
      await tx.orgMemeberShip.create({
        data: {
          userId: user.id,
          organisationId: org.id,
          orgRole: OrgRole.SUPER_ADMIN,
        },
      });

      const site = await tx.site.create({
        data: {
          organisationId: org.id,
          address: dto.address,
          contactName: `${dto.firstName} ${dto.lastName}`,
          contactEmail: email,
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
          grantedBy:user.id
        }
      })
      return { org, site };
    });

    await this.authCacheManaher.storeEmailVerificationOtp(email, otp);
    await Promise.all([
      this.geoSearch.indexFarmerConsumer(
        result.org.id,
        dto.latitude,
        dto.longitude,
        dto.region,
      ),
      this.geoSearch.indexFarmerConsumerSite(
        result.site.id,
        dto.latitude,
        dto.longitude,
        dto.region,
      ),
      this.emailService.sendOtp({
        to: email,
        otp: otp.toString(),
        name: dto.firstName,
      }),
    ]);
    return {
      message: 'Account created, check your inbox to verify your email',
    };
  }

  async registerFarmerProducer(
    dto: RegisterFarmerProducerDto,
    logo?: Express.Multer.File,
  ) {
    const email = normalizeEmail(dto.email);
    await this.assertEmailUnique(email);
    // No subscription at signup — farmer producers pick a plan afterwards.
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

    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          firstName: dto.firstName,
          lastName: dto.lastName,
          email,
          passwordHash,
          phoneNumber: dto.mobileNumber ?? '',
          platformRole: PlatformRole.ORG_USER,
          emailverifyToken: verifyToken,
          emailVerifyExpiry: verifyExpiery,
        },
      });
      const org = await tx.organisation.create({
        data: {
          name: dto.businessName,
          address: dto.businessAddress,
          organizationType: OrgType.FARMER_PRODUCER,
          venueType: dto.venueType,
          brandName: dto.brandName ?? 'not provided',
          latitude: dto.latitude,
          longitude: dto.longitude,
          region: dto.region,
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
      const site = await tx.site.create({
        data: {
          organisationId: org.id,
          address: dto.businessAddress,
          contactName: `${dto.firstName} ${dto.lastName}`,
          contactEmail: email,
          latitude: dto.latitude,
          longitude: dto.longitude,
          contactMobile: dto.mobileNumber ?? '',
          organisationName: dto.businessName,
        },
      });
      await tx.siteAccess.create({
        data: {
          userId: user.id,
          siteId: site.id,
          organisationId: org.id,
          siteRole: SiteRole.SITE_ADMIN,
          grantedBy:user.id
        }
      })
      return { org };
    });

    await this.authCacheManaher.storeEmailVerificationOtp(email, otp);
    await Promise.all([
      this.geoSearch.indexBusiness(
        result.org.id,
        dto.latitude,
        dto.longitude,
        dto.region,
      ),
      this.emailService.sendOtp({
        to: email,
        otp: otp.toString(),
        name: dto.firstName,
      }),
    ]);
    return {
      message: 'Account created, check your inbox to verify your email',
    };
  }

  async login(dto: LoginDto) {
    const email = normalizeEmail(dto.email);
    const currentLoginAttempts =
      await this.authCacheManaher.incrementLoginattempts(email);
    if (currentLoginAttempts > 5) {
      throw new ForbiddenException(
        'Too many login attepmts, Try again after 15 Minutes',
      );
    }
    const user = await this.prisma.user.findFirst({
      where: {
        email: { equals: email, mode: 'insensitive' },
      },
    });
    if (!user || !user.isActive)
      throw new UnauthorizedException('User not found');
    const passwordMatch = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordMatch) throw new UnauthorizedException('Invalid Credentials');
    if (!user.emailVerified)
      throw new ForbiddenException(
        'Please verify your email before logging in',
      );

    await this.authCacheManaher.clearLoginAttempts(email);

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
      include: {
        organisation: {
          include: { subscription: { include: { plan: true } } },
        },
      },
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

    const accessToken = await this.generateTokens(
      user,
      memberShip,
      primarySiteAccess,
    );

    return {
      accessToken,
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        platformRole: user.platformRole,
      },
      organisation: {
        id: organisationId,
        name: memberShip.organisation.name,
      },
      role: {
        orgRole: memberShip.orgRole,
        enterpriseRole: memberShip.enterpriseRole ?? null,
        siteRole: primarySiteAccess?.siteRole ?? null,
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
    // Distinguishes an unused invite from a user who has actually signed in.
    await this.prisma.user
      .update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
      .catch(() => undefined);

    const accessToken = await this.jwtService.sign(payload);
    return accessToken;
  }

  async verifyEmail(dto: VerifyEmailOtpDto) {
    const email = normalizeEmail(dto.email);
    const cachedOtp = await this.authCacheManaher.getEmailVerifyOtp(email);
    if (!cachedOtp) {
      throw new BadRequestException(
        'OTP has expired, please request a new one',
      );
    }
    if (cachedOtp !== dto.otp) {
      throw new BadRequestException('Invalid OTP');
    }

    const existingUser = await this.findUserByEmail(email);
    if (!existingUser) {
      throw new NotFoundException('User not found');
    }

    const user = await this.prisma.user.update({
      where: { id: existingUser.id },
      data: {
        emailVerified: true,
        emailverifyToken: null,
        emailVerifyExpiry: null,
        email,
      },
    });

    await this.authCacheManaher.revokeEmailVerifyOtp(email);

    const membership = await this.prisma.orgMemeberShip.findFirst({
      where: { userId: user.id },
      include: {
        organisation: {
          include: { subscription: { include: { plan: true } } },
        },
      },
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
    const email = normalizeEmail(dto.email);
    await this.assertEmailUnique(email);
    const passwordHash = await bcrypt.hash(dto.password, 10);

    const user = await this.prisma.user.create({
      data: {
        firstName: dto.firstName,
        lastName: dto.lastName,
        email,
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
        role: {
          platformRole: user.platformRole,
          orgRole: null,
          siteRole: null,
        },
        subscription: null,
        sites: [],
      };
    }

    const membership = await this.prisma.orgMemeberShip.findFirst({
      where: { userId: user.id },
      include: {
        organisation: {
          include: {
            subscription: { include: { plan: true } },
            charityPickupPrefs: { select: { radiusKm: true } },
          },
        },
      },
    });
    if (!membership)
      throw new UnauthorizedException('No organisation found for this user');

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
            pickupRadiusKm: true,
            isActive: true,
            latitude: true,
            longitude: true,
          },
        },
      },
      orderBy: { grantedAt: 'asc' },
    });

    const { subscription } = organisation;

    const primarySitePickupRadiusKm = siteAccesses[0]?.site.pickupRadiusKm ?? null;

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
      organisation: this.formatOrganisationProfile(
        organisation,
        primarySitePickupRadiusKm,
      ),
      role: {
        platformRole: user.platformRole,
        orgRole: membership.orgRole,
        enterpriseRole: membership.enterpriseRole ?? null,
        siteRole: siteAccesses[0]?.siteRole ?? null,
      },
      subscription: subscription
        ? {
            plan: {
              name: subscription.plan.name,
              displayName: subscription.plan.displayName,
              priceMonthly: subscription.plan.priceMonthly,
              priceAnnual: subscription.plan.priceAnnual,
              features: subscription.plan.features,
              maxSites: subscription.plan.maxSites,
              maxUsersPerSite: subscription.plan.maxUserPerSite,
            },
            status: subscription.status,
            billingCycle: subscription.billingCycle,
            trialEndsAt: subscription.trialEndsAt,
            currentPeriodEnd: subscription.currentPeriodEnd,
          }
        : null,
      sites: siteAccesses.map((sa) =>
        this.formatSiteProfile(sa.site, sa.siteRole, sa.grantedAt),
      ),
    };
  }

  async updateProfile(userId: number, phoneNumber: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');

    await this.prisma.user.update({
      where: { id: userId },
      data: { phoneNumber },
    });

    return this.getProfile(userId);
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    
    if (!user || !user.isActive) {
      throw new NotFoundException("user not found with this email ID")
    }

    const otp = GenerateOtp();
    await this.authCacheManaher.storePasswordResetOtp(
      dto.email.toLowerCase(),
      otp,
    );

    await this.emailService.sendPasswordReset({
      to: dto.email,
      resetToken: otp,
      name: user.firstName,
    });

    this.logger.log(`Password reset OTP sent: ${dto.email}`);
    return {
      message: 'a reset code has been sent.',
    };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const cachedOtp = await this.authCacheManaher.getPasswordResetOtp(
      dto.email.toLowerCase(),
    );

    if (!cachedOtp) {
      throw new BadRequestException(
        'Reset code has expired. Please request a new one.',
      );
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
    return {
      message: 'Password has been reset successfully. You can now log in.',
    };
  }

  private formatOrganisationProfile(
    organisation: Organisation & {
      charityPickupPrefs?: { radiusKm: number } | null;
    },
    primarySitePickupRadiusKm?: number | null,
  ) {
    const isBusiness = PROFILE_BUSINESS_TYPES.includes(organisation.organizationType);
    const isCharity = PROFILE_CHARITY_TYPES.includes(organisation.organizationType);
    const pickupRadiusKm =
      organisation.charityPickupPrefs?.radiusKm ?? primarySitePickupRadiusKm ?? null;

    return {
      id: organisation.id,
      name: organisation.name,
      type: organisation.organizationType,
      registrationNumber: organisation.registrationNumber,
      address: organisation.address,
      ...(isBusiness && { businessAddress: organisation.address }),
      ...(isCharity && { charityAddress: organisation.address }),
      brandName: organisation.brandName,
      venueType: organisation.venueType,
      logoUrl: organisation.logoUrl,
      region: organisation.region,
      latitude: organisation.latitude,
      longitude: organisation.longitude,
      ratingAvg: organisation.ratingAvg,
      ratingCount: organisation.ratingCount,
      createdAt: organisation.createdAt,
      ...(isCharity && pickupRadiusKm !== null && { pickupRadiusKm }),
    };
  }

  private formatSiteProfile(
    site: {
      id: number;
      organisationName: string;
      address: string;
      postcode: string | null;
      contactEmail: string;
      contactMobile: string;
      pickupRadiusKm: number | null;
      isActive: boolean;
      latitude?: number | null;
      longitude?: number | null;
    },
    siteRole?: string,
    grantedAt?: Date,
  ) {
    return {
      id: site.id,
      name: site.organisationName,
      address: site.address,
      postcode: site.postcode,
      contactEmail: site.contactEmail,
      contactMobile: site.contactMobile,
      pickupRadiusKm: site.pickupRadiusKm,
      isActive: site.isActive,
      latitude: site.latitude ?? null,
      longitude: site.longitude ?? null,
      ...(siteRole !== undefined && { siteRole }),
      ...(grantedAt !== undefined && { grantedAt }),
    };
  }

  private async findUserByEmail(email: string): Promise<User | null> {
    const normalized = normalizeEmail(email);
    return this.prisma.user.findFirst({
      where: {
        email: { equals: normalized, mode: 'insensitive' },
      },
    });
  }

  private async assertEmailUnique(email: string) {
    const existing = await this.findUserByEmail(email);
    if (existing)
      throw new ConflictException('An account with this email already exists');
  }

  private async ensureUserUnique(email: string, phoneNumber: string) {
    const [userExistsByEmail, userExistsByPhone] = await Promise.all([
      await this.prisma.user.findUnique({ where: { email } }),
      await this.prisma.user.findFirst({ where: { phoneNumber } }),
    ]);
  }

  async resendVerificationEmail(emailInput: string) {
    const email = normalizeEmail(emailInput);
    const user = await this.findUserByEmail(email);
    if (!user) throw new NotFoundException('user with this email not found');
    if (user.emailVerified === true) {
      throw new BadRequestException('email already verified');
    }
    const otp = GenerateOtp();
    await this.authCacheManaher.storeEmailVerificationOtp(email, otp);
    await this.emailService.sendOtp({
      to: email,
      otp: otp.toString(),
      name: user.firstName,
    });
    return {
      message: 'Verification code sent',
    };
  }
}
