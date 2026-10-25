import {
  Body,
  Controller,
  Get,
  Header,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards';
import { AuthUser } from '../common/decorators';
import { IAuthUser } from '../common/interfaces';
import {
  successGetRes,
  successRes,
} from '../common/interceptors/response.handlers';
import { ReportsService } from './reports.service';
@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}
  @Post()
  @Header('Cache-Control', 'private, no-store')
  async create(@AuthUser() actor: IAuthUser, @Body() body: unknown) {
    return successRes(await this.reports.intake(actor.id, body));
  }
  @Get('me')
  @Header('Cache-Control', 'private, no-store')
  async mine(
    @AuthUser() actor: IAuthUser,
    @Query('before') before?: string,
    @Query('limit') limit?: number,
  ) {
    return successGetRes(await this.reports.mine(actor.id, before, limit));
  }
  @Get('notices')
  @Header('Cache-Control', 'private, no-store')
  async notices(@AuthUser() actor: IAuthUser) {
    return successGetRes(await this.reports.notices(actor.id));
  }
}
