import { BadRequestException, Body, Controller, Delete, Put, Get, Header, Patch, Query, UseGuards, ValidationPipe } from '@nestjs/common';
import { AuthUser } from '../common/decorators';
import { JwtAuthGuard } from '../common/guards';
import { IAuthUser } from '../common/interfaces';
import { successRes } from '../common/interceptors';
import { PushDelivery, validPushToken } from './push-delivery';
import { NotificationService } from './notification.service';
import { NotificationPageDto, ReadNotificationsDto } from './notification.dto';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationController {
  constructor(private readonly notifications: NotificationService, private readonly push: PushDelivery) {}

  @Put('push-token')
  async register(@AuthUser() actor: IAuthUser, @Body() body: { token?: unknown }) {
    if (!validPushToken(body?.token)) throw new BadRequestException('Invalid push token');
    await this.push.register(actor.id, body.token); return successRes({ registered: true });
  }
  @Delete('push-token')
  async unregister(@AuthUser() actor: IAuthUser, @Body() body: { token?: unknown }) {
    if (!validPushToken(body?.token)) throw new BadRequestException('Invalid push token');
    await this.push.register(actor.id, body.token, true); return successRes({ removed: true });
  }
  @Get()
  @Header('Cache-Control', 'private, no-store')
  async list(@AuthUser() actor: IAuthUser,
    @Query(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })) query: NotificationPageDto) {
    return successRes(await this.notifications.list(actor.id, query.before));
  }

  @Patch('read')
  async read(@AuthUser() actor: IAuthUser,
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })) body: ReadNotificationsDto) {
    await this.notifications.markRead(actor.id, body.ids);
    return successRes({ read: true });
  }
}
