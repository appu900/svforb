import {
  Logger,
  Injectable,
  ConflictException,
  ForbiddenException,
  BadRequestException,
  UnauthorizedException,
  NotFoundException,
  ServiceUnavailableException,
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
  SubscriptionStatus,
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
    private readonly proximityService: ProximityService,
    private readonly geoSearch: RedisGeoSearchService,
  ) {}

  async registerBusiness(dto: RegisterBusinessDto, logo?: Express.Multer.File) {
    await this.assertEmailUnique(dto.email);
    const trialPlan = await this.prisma.subscriptionPlan.findFirst({
      where: { name: 'FREE_TRIAL', isActive: true },
    });
    console.log('this is the trial plan', trialPlan);
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
          brandName: dto.brandName ?? '',
          latitude: dto.latitude,
          longitude: dto.longitude,
          logoUrl: uploadLogoUrl,
        },
      });

      await tx.orgSubscription.create({
        data: {
          organisationId: org.id,
          planId: trialPlan!.id,
          status: SubscriptionStatus.TRIALING,
          trialEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
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

    await this.geoSearch.indexBusiness(
      result.org.id,
      dto.latitude,
      dto.longitude,
      dto.region,
    );
    await this.emailService.sendOtp({
      to: dto.email,
      otp: otp.toString(),
      name: dto.firstName,
    });
    await this.authCacheManaher.storeEmailVerificationOtp(dto.email, otp);
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

    await this.assertEmailUnique(dto.email);
    const trialPlan = await this.prisma.subscriptionPlan.findFirst({
      where: { name: 'FREE_TRIAL', isActive: true },
    });
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
          latitude: dto.latitude,
          longitude: dto.longitude,
          logoUrl: uploadedLogoUrl,
          region: dto.region,
        },
      });

      await tx.orgSubscription.create({
        data: {
          organisationId: org.id,
          planId: trialPlan!.id,
          status: SubscriptionStatus.ACTIVE,
          trialEndsAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        },
      });

      await tx.orgMemeberShip.create({
        data: {
          userId: user.id,
          organisationId: org.id,
          orgRole: OrgRole.SUPER_ADMIN,
        },
      });

      let site: { id: number } | null = null;
      if (dto.charityType === OrgType.CHARITY_SINGLE) {
        site = await tx.site.create({
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
            siteId: site!.id,
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

      return {
        user,
        org,
        site: dto.charityType === OrgType.CHARITY_SINGLE ? site : null,
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

    await Promise.all([
      this.emailService.sendOtp({
        to: dto.email,
        otp: otp.toString(),
        name: dto.firstName,
      }),
      this.authCacheManaher.storeEmailVerificationOtp(dto.email, otp),
    ]);
    this.logger.log(
      `Charity registered: ${dto.email} type=${dto.charityType} org=${result.org.name}`,
    );

    return {
      message: 'Account created, check your inbox to verify your email',
    };
  }

  private async prepareFarmerConsumerRegistration(
    dto: RegisterFarmerConsumerDto,
    logo?: Express.Multer.File,
  ): Promise<{
    passwordHash: string;
    trialPlanId: number;
    otp: string;
    logoUrl: string;
  }> {
    await this.assertEmailUnique(dto.email);
    const [passwordHash, subscription] = await Promise.all([
      bcrypt.hash(dto.password, 10),
      this.prisma.subscriptionPlan.findFirst({
        where: { name: 'FREE_TRIAL', isActive: true },
      }),
    ]);
    if (!subscription) {
      throw new ServiceUnavailableException('no active trial plan found');
    }
    const logoUrl = logo
      ? await this.s3.uploadFile(logo, this.IMAGE_UPLOAD_FILE_NAME)
      : '';
    const otp = GenerateOtp();
    return {
      passwordHash,
      trialPlanId: subscription.id,
      otp,
      logoUrl,
    };
  }

  async registerFarmerConsumer(
    dto: RegisterFarmerConsumerDto,
    logo?: Express.Multer.File,
  ) {
    const { passwordHash, trialPlanId, otp, logoUrl } =
      await this.prepareFarmerConsumerRegistration(dto, logo);
    const verifyToken = randomBytes(32).toString('hex');
    const verifyExpiery = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          firstName: dto.firstName,
          lastName: dto.lastName,
          email: dto.email,
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
      const subscriptionPlan = await tx.orgSubscription.create({
        data: {
          organisationId: org.id,
          planId: trialPlanId,
          trialEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
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
          grantedBy:user.id
        }
      })
      return { org, site };
    });

    await this.geoSearch.indexFarmerConsumer(
      result.org.id,
      dto.latitude,
      dto.longitude,
      dto.region,
    );
    await this.geoSearch.indexFarmerConsumerSite(
      result.site.id,
      dto.latitude,
      dto.longitude,
      dto.region,
    );

    await Promise.all([
      this.emailService.sendOtp({
        to: dto.email,
        otp: otp.toString(),
        name: dto.firstName,
      }),
      this.authCacheManaher.storeEmailVerificationOtp(dto.email, otp),
    ]);
    return {
      message: 'Account created, check your inbox to verify your email',
    };
  }

  async registerFarmerProducer(
    dto: RegisterFarmerProducerDto,
    logo?: Express.Multer.File,
  ) {
    await this.assertEmailUnique(dto.email);
    const subscription = await this.prisma.subscriptionPlan.findFirst({
      where: { name: 'FREE_TRIAL', isActive: true },
    });
    if (!subscription) {
      this.logger.debug('free trial plan not found here...');
      throw new ServiceUnavailableException();
    }
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
          email: dto.email,
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
          logoUrl: uploadLogoUrl,
        },
      });
      const subscriptionPlan = await tx.orgSubscription.create({
        data: {
          organisationId: org.id,
          planId: subscription.id,
          status: SubscriptionStatus.TRIALING,
          trialEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
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
          contactEmail: dto.email ?? '',
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

    await this.geoSearch.indexBusiness(
      result.org.id,
      dto.latitude,
      dto.longitude,
      dto.region,
    );

    await Promise.all([
      this.emailService.sendOtp({
        to: dto.email,
        otp: otp.toString(),
        name: dto.firstName,
      }),
      this.authCacheManaher.storeEmailVerificationOtp(dto.email, otp),
    ]);
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
        'Please verify your email before logging in',
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
      throw new BadRequestException(
        'OTP has expired, please request a new one',
      );
    }
    if (cachedOtp !== dto.otp) {
      throw new BadRequestException('Invalid OTP');
    }

    const user = await this.prisma.user.update({
      where: { email: dto.email.toLowerCase() },
      data: {
        emailVerified: true,
        emailverifyToken: null,
        emailVerifyExpiry: null,
      },
    });

    await this.authCacheManaher.revokeEmailVerifyOtp(dto.email);

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
          include: { subscription: { include: { plan: true } } },
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
      return {
        message: 'If that email is registered, a reset code has been sent.',
      };
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
      message: 'If that email is registered, a reset code has been sent.',
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

  async resendVerificationEmail(email: string) {
    const user = await this.prisma.user.findUnique({
      where: {
        email: email,
      },
    });
    if (!user) throw new NotFoundException('user with this email not found');
    if (user.emailVerified === true)
      return new BadRequestException('email already verified');
    const otp = GenerateOtp();
    await this.emailService.sendOtp({
      to: email,
      otp: otp.toString(),
      name: user.firstName,
    });
    await this.authCacheManaher.storeEmailVerificationOtp(email, otp);
    return {
      message: 'done',
    };
  }
}
