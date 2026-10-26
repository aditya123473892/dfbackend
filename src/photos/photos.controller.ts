import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { AuthUser } from '../common/decorators';
import { JwtAuthGuard } from '../common/guards';
import { IAuthUser } from '../common/interfaces';
import { successRes } from '../common/interceptors';
import { ConfirmPhotoDto, UploadUrlDto } from './photo.dto';
import { PhotosService } from './photos.service';

@Controller('photos')
@UseGuards(JwtAuthGuard)
export class PhotosController {
  constructor(private readonly photos: PhotosService) {}

  @Post('upload-url')
  async issue(
    @AuthUser() actor: IAuthUser,
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    dto: UploadUrlDto,
  ) {
    return successRes(
      await this.photos.issue(actor.id, dto.contentType, dto.requestId),
    );
  }

  @Post('confirm')
  async confirm(
    @AuthUser() actor: IAuthUser,
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    dto: ConfirmPhotoDto,
  ) {
    return successRes(await this.photos.confirm(actor.id, dto.uploadId));
  }

  @Delete(':id')
  async remove(@AuthUser() actor: IAuthUser, @Param('id') id: string) {
    await this.photos.deleteUnattached(actor.id, id);
    return successRes({ deleted: true });
  }
}
