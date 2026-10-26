import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AuthUser } from '../common/decorators';
import { JwtAuthGuard } from '../common/guards';
import { IAuthUser } from '../common/interfaces';
import { badRequestRes, successRes } from '../common/interceptors';
import { BlockService } from './block.service';
import { BadRequestException } from '@nestjs/common';
const id = z
  .string()
  .regex(/^[a-f\d]{24}$/i)
  .transform((value) => value.toLowerCase());
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UserBlocksController {
  constructor(private readonly blocks: BlockService) {}
  @Get('me/blocks')
  async list(@AuthUser() actor: IAuthUser, @Query() query: unknown) {
    const parsed = z
      .object({
        before: id.optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      })
      .strict()
      .safeParse(query);
    if (!parsed.success)
      throw new BadRequestException('Invalid block list request');
    return successRes(
      await this.blocks.list(actor.id, parsed.data.before, parsed.data.limit),
    );
  }
  @Post(':id/block')
  async block(
    @AuthUser() actor: IAuthUser,
    @Param('id') target: string,
    @Body() body: unknown,
  ) {
    const parsed = id.safeParse(target);
    if (!parsed.success) return badRequestRes('User not found!');
    if (body && !z.object({}).strict().safeParse(body).success)
      throw new BadRequestException('Invalid block request');
    try {
      return successRes(await this.blocks.block(actor.id, parsed.data));
    } catch (error) {
      if (error.getStatus?.() === 404) return badRequestRes('User not found!');
      throw error;
    }
  }
  @Delete(':id/block')
  async unblock(@AuthUser() actor: IAuthUser, @Param('id') target: string) {
    const parsed = id.safeParse(target);
    if (!parsed.success) return badRequestRes('User not found!');
    return successRes(await this.blocks.unblock(actor.id, parsed.data));
  }
}
