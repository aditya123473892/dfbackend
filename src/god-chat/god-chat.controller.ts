import { Body, Controller, Get, Header, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, RolesGuard } from '../common/guards';
import { AuthUser, Roles } from '../common/decorators';
import { ERole } from '../common/enums';
import { IAuthUser } from '../common/interfaces';
import { successGetRes, successRes } from '../common/interceptors/response.handlers';
import { GodChatService } from './god-chat.service';
import { GodChatSessionsService, parseSessions, sessionListInput, staffMessageInput } from './god-chat-sessions.service';
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

  /** The member's open conversation (or null), polled so admin replies show up. */
  @Get('session')
  @Header('Cache-Control', 'private, no-store')
  async session(@AuthUser() actor: IAuthUser) {
    return successGetRes(await this.godChat.session(actor.id));
  }

  /** Body: { id, content }. Stores the message and returns the session with God's reply, if any. */
  @Post('messages')
  @Header('Cache-Control', 'private, no-store')
  async send(@AuthUser() actor: IAuthUser, @Body() body: unknown) {
    return successRes(await this.godChat.send(actor.id, body));
  }

  /** Ends the open conversation so the next message starts a fresh one. */
  @Post('session/new')
  @Header('Cache-Control', 'private, no-store')
  async newSession(@AuthUser() actor: IAuthUser) {
    return successRes(await this.godChat.newSession(actor.id));
  }

  /** Legacy stateless form. Body: { messages: [{ role: 'user' | 'assistant', content }] }, newest last. */
  @Post()
  @Header('Cache-Control', 'private, no-store')
  async create(@AuthUser() actor: IAuthUser, @Body() body: unknown) {
    return successRes(await this.godChat.reply(actor.id, body));
  }
}

/** Admins watch every open God chat and can take one over to answer in person. */
@ApiTags('Admin God chat')
@ApiBearerAuth()
@Controller('admin/god-chat')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(ERole.ADMIN)
export class AdminGodChatController {
  constructor(private readonly sessions: GodChatSessionsService) {}

  @Get('sessions')
  @Header('Cache-Control', 'private, no-store')
  async list(@Query() query: Record<string, unknown>) {
    return successGetRes(await this.sessions.list(parseSessions(sessionListInput, query)));
  }

  @Get('sessions/:id')
  @Header('Cache-Control', 'private, no-store')
  async detail(@Param('id') id: string) {
    return successGetRes(await this.sessions.detail(id));
  }

  @Post('sessions/:id/takeover')
  async takeOver(@AuthUser() actor: IAuthUser, @Param('id') id: string) {
    return successRes(await this.sessions.takeOver(actor.id, id));
  }

  @Post('sessions/:id/release')
  async release(@AuthUser() actor: IAuthUser, @Param('id') id: string) {
    return successRes(await this.sessions.release(actor.id, id));
  }

  @Post('sessions/:id/messages')
  async reply(@AuthUser() actor: IAuthUser, @Param('id') id: string, @Body() body: unknown) {
    return successRes(await this.sessions.staffReply(actor.id, id, parseSessions(staffMessageInput, body)));
  }
}
