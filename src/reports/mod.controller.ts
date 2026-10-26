import { Body, Controller, Get, Header, Param, Patch, Post, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { AuthUser, Roles } from '../common/decorators';
import { ERole } from '../common/enums';
import { JwtAuthGuard, RolesGuard } from '../common/guards';
import { successGetRes, successRes } from '../common/interceptors/response.handlers';
import { ModCaseGuard, ModFeatureGuard } from './mod.guard';
import { ModService } from './mod.service';
import { evidenceInput, parseMod } from './mod-input';
@Controller('mod')
@UseGuards(ModFeatureGuard, JwtAuthGuard, RolesGuard, ModCaseGuard)
@Roles(ERole.MODERATOR, ERole.ADMIN, ERole.ROOT)
export class ModController {
  constructor(private readonly mod: ModService) {}
  @Get('reports')
  async queue(@AuthUser() actor: any, @Query('before') before?: string) { return successGetRes(await this.mod.queue(actor, before)); }
  @Get('blocks')
  async blocks(@AuthUser() actor: any, @Query('before') before?: string) { return successGetRes(await this.mod.listBlocks(actor, before)); }
  @Get('blocks/summary')
  async blockSummary(@AuthUser() actor: any) { return successGetRes(await this.mod.blockSummary(actor)); }
  @Get('review-queue')
  async review(@AuthUser() actor: any) { return successGetRes(await this.mod.reviewQueue(actor)); }
  @Get('reports/:reportId')
  async detail(@AuthUser() actor: any, @Param('reportId') id: string) { return successGetRes(await this.mod.detail(actor, id)); }
  @Patch('reports/:reportId/assignment')
  async assign(@AuthUser() actor: any, @Param('reportId') id: string, @Body() body: unknown) { return successRes(await this.mod.mutate(actor, id, 'assign', body)); }
  @Patch('reports/:reportId/status')
  async transition(@AuthUser() actor: any, @Param('reportId') id: string, @Body() body: unknown) { return successRes(await this.mod.mutate(actor, id, 'transition', body)); }
  @Post('reports/:reportId/actions')
  async action(@AuthUser() actor: any, @Param('reportId') id: string, @Body() body: unknown) { return successRes(await this.mod.mutate(actor, id, 'action', body)); }
  @Patch('reports/:reportId/legal-hold')
  @Roles(ERole.ADMIN, ERole.ROOT)
  async legalHold(@AuthUser() actor: any, @Param('reportId') id: string, @Body() body: unknown) { return successRes(await this.mod.mutate(actor, id, 'legal-hold', body)); }
  @Post('reports/:reportId/evidence/:imageId/view')
  @Header('Pragma', 'no-cache')
  async evidence(@AuthUser() actor: any, @Param('reportId') id: string, @Param('imageId') imageId: string, @Body() body: unknown) {
    parseMod(evidenceInput, body);
    const result = await this.mod.evidence(actor, id, imageId);
    if (result.bytes) return new StreamableFile(result.bytes, { type: 'image/jpeg', disposition: 'inline' });
    return successGetRes(result);
  }
}
