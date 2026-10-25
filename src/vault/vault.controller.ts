import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AuthUser } from '../common/decorators';
import { JwtAuthGuard, OtpSessionGuard } from '../common/guards';
import { IAuthUser } from '../common/interfaces';
import { successRes } from '../common/interceptors';
import { VaultService } from './vault.service';
import { parse, uploadInput, confirmInput, editInput, deleteInput, photoId, cursorInput } from './vault.validation';

@Controller('vault')
// The vault is mobile-only: with MOBILE_OTP_ONLY_ROUTES=on it requires a phone OTP session.
@UseGuards(JwtAuthGuard, OtpSessionGuard)
export class VaultController {
  constructor(private readonly vault: VaultService) {}
  @Post('upload-url')
  async upload(@AuthUser() actor: IAuthUser, @Body() body: unknown) { return successRes(await this.vault.issue(actor.id, parse(uploadInput, body))); }
  @Post('confirm')
  async confirm(@AuthUser() actor: IAuthUser, @Body() body: unknown) { return successRes(await this.vault.confirm(actor.id, parse(confirmInput, body).id)); }
  @Get('changes')
  async changes(@AuthUser() actor: IAuthUser, @Query('since') cursor = '', @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store'); return successRes(await this.vault.changes(actor.id, parse(cursorInput, cursor)));
  }
  @Get(':id/download-url')
  async download(@AuthUser() actor: IAuthUser, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store'); return successRes(await this.vault.download(actor.id, parse(photoId, id)));
  }
  @Patch(':id')
  async edit(@AuthUser() actor: IAuthUser, @Param('id') id: string, @Body() body: unknown) { return successRes(await this.vault.edit(actor.id, parse(photoId, id), parse(editInput, body))); }
  @Delete(':id')
  async remove(@AuthUser() actor: IAuthUser, @Param('id') id: string, @Body() body: unknown) { return successRes(await this.vault.remove(actor.id, parse(photoId, id), parse(deleteInput, body).updatedAt)); }
}
