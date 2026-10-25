import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, UseGuards, ValidationPipe } from '@nestjs/common';
import { AuthUser } from '../common/decorators';
import { JwtAuthGuard } from '../common/guards';
import { IAuthUser } from '../common/interfaces';
import { successRes } from '../common/interceptors';
import { ConfirmVideoDto, VideoUploadUrlDto } from './photo.dto';
import { VideosService } from './videos.service';

@Controller('videos')
@UseGuards(JwtAuthGuard)
export class VideosController {
  constructor(private readonly videos: VideosService) {}

  @Post('upload-url')
  async issue(@AuthUser() actor: IAuthUser,
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })) dto: VideoUploadUrlDto) {
    return successRes(await this.videos.issue(actor.id, dto.contentType, dto.requestId, dto.size));
  }

  @Post('confirm')
  async confirm(@AuthUser() actor: IAuthUser,
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })) dto: ConfirmVideoDto) {
    return successRes(await this.videos.confirm(actor.id, dto.uploadId));
  }

  @Get(':id')
  async status(@AuthUser() actor: IAuthUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return successRes(await this.videos.status(actor.id, id));
  }

  @Delete(':id')
  async remove(@AuthUser() actor: IAuthUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    await this.videos.deleteUnattached(actor.id, id);
    return successRes({ deleted: true });
  }
}
