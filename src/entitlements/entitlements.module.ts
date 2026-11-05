import { Body, Controller, Get, Injectable, Module, Param, Patch, Query, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { AuthUser, Roles } from '../common/decorators';
import { ERole } from '../common/enums';
import { JwtAuthGuard, RolesGuard } from '../common/guards';
import { AdminPremiumService, memberListInput, parseMemberInput, premiumChangeInput } from './admin-premium.service';
import { IAuthUser } from '../common/interfaces';
import { successRes } from '../common/interceptors';
import { isPremium } from '../posts/post.mapper';
import { originalUrlSeconds } from '../photos/media.service';

/** Implement only after signature, product, user binding and replay verification exist. */
export interface EntitlementProviderVerifier {
  verify(rawBody: Buffer, signature: string): Promise<{
    eventId: string; userId: string; premiumUntil: Date | null;
  }>;
}

@Injectable()
export class DisabledEntitlementVerifier implements EntitlementProviderVerifier {
  // TODO: wire a store/provider verifier and durable idempotent entitlement writes.
  // No public write/webhook route exists until that verification is implemented.
  async verify(_rawBody: Buffer, _signature: string): Promise<never> {
    throw new ServiceUnavailableException('Subscriptions are not yet available');
  }
}

@Injectable()
export class EntitlementsService {
  constructor(@InjectConnection() private readonly db: Connection) {}
  async status(userId: string) {
    const user = await this.db.db.collection<any>('Users').findOne(
      { _id: new Types.ObjectId(userId) }, { projection: { premiumUntil: 1 } });
    return { active: isPremium(user), premiumUntil: user?.premiumUntil || null,
      serverTime: new Date(), providerAvailable: false, imageUrlSeconds: originalUrlSeconds() };
  }
}

@Controller('entitlements')
@UseGuards(JwtAuthGuard)
export class EntitlementsController {
  constructor(private readonly entitlements: EntitlementsService) {}
  @Get('me')
  async status(@AuthUser() actor: IAuthUser) {
    return successRes(await this.entitlements.status(actor.id));
  }
}

/** Admins move members between normal and premium (manual grants; no payment involved). */
@Controller('admin/users')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(ERole.ADMIN)
export class AdminPremiumController {
  constructor(private readonly premium: AdminPremiumService) {}
  @Get()
  async list(@Query() query: Record<string, unknown>) {
    return successRes(await this.premium.list(parseMemberInput(memberListInput, query)));
  }
  @Patch(':id/premium')
  async setPremium(@AuthUser() actor: IAuthUser, @Param('id') id: string, @Body() body: unknown) {
    return successRes({ user: await this.premium.setPremium(actor.id, id, parseMemberInput(premiumChangeInput, body)) });
  }
}

@Module({
  providers: [EntitlementsService, DisabledEntitlementVerifier, AdminPremiumService],
  controllers: [EntitlementsController, AdminPremiumController],
})
export class EntitlementsModule {}
