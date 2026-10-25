import { Body, Controller, Get, Header, Patch, Query, UseGuards, ValidationPipe } from '@nestjs/common';
import { AuthUser } from '../common/decorators';
import { JwtAuthGuard } from '../common/guards';
import { IAuthUser } from '../common/interfaces';
import { successRes } from '../common/interceptors';
import { NotificationService } from './notification.service';
import { NotificationPageDto, ReadNotificationsDto } from './notification.dto';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

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
