import { Body, Controller, Get, Header, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards';
import { AuthUser } from '../common/decorators';
import { IAuthUser } from '../common/interfaces';
import { successGetRes, successRes } from '../common/interceptors/response.handlers';
import { GodChatService } from './god-chat.service';
import { LlmClient } from './llm.client';

@ApiTags('god-chat')
@ApiBearerAuth()
@Controller('god-chat')
@UseGuards(JwtAuthGuard)
export class GodChatController {
  constructor(
    private readonly godChat: GodChatService,
    private readonly llm: LlmClient,
  ) {}

  /** Lets the app show "unavailable" before the user types anything. */
  @Get('status')
  @Header('Cache-Control', 'private, no-store')
  status() {
    return successGetRes({ available: this.llm.configured });
  }

  /** Body: { messages: [{ role: 'user' | 'assistant', content }] }, newest last. Stateless. */
  @Post()
  @Header('Cache-Control', 'private, no-store')
  async create(@AuthUser() actor: IAuthUser, @Body() body: unknown) {
    return successRes(await this.godChat.reply(actor.id, body));
  }
}
