import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { SkipSubscriptionCheck } from '../../subscriptions/decorators/skip-subscription-check.decorator';
import { AcceptInvitationDto } from '../dto/enterprise.dto';
import { EnterpriseInvitationService } from '../services/enterprise-invitation.service';

/**
 * Account activation, reached from an emailed link.
 *
 * Deliberately unauthenticated: the invited person has no account yet, so
 * there is nothing to authenticate against. The single-use hashed token is the
 * credential, and every route re-validates it rather than trusting the client.
 */
@Controller('enterprise/invitations')
@SkipSubscriptionCheck()
export class EnterpriseActivationController {
  constructor(private readonly invitations: EnterpriseInvitationService) {}

  /**
   * What the activation screen shows before the password form: the Enterprise
   * and Role assigned, plus the email, which cannot be changed.
   *
   * Failure modes return distinct codes so the client can route correctly —
   * `INVITATION_ALREADY_ACCEPTED` to sign in, `INVITATION_EXPIRED` to a resend
   * request.
   */
  @Get(':token')
  describe(@Param('token') token: string) {
    return this.invitations.describe(token);
  }

  /** Creates the account with the user's own password and marks it Active. */
  @Post(':token/accept')
  accept(@Param('token') token: string, @Body() dto: AcceptInvitationDto) {
    return this.invitations.accept(token, dto.password, dto.acceptTerms);
  }
}
