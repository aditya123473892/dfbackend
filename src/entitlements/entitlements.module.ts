import { Controller, Get, Injectable, Module, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { AuthUser } from '../common/decorators';
import { JwtAuthGuard } from '../common/guards';
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

@Module({ providers: [EntitlementsService, DisabledEntitlementVerifier], controllers: [EntitlementsController] })
export class EntitlementsModule {}
