import { Module } from '@nestjs/common';
import { AdminGodChatController, GodChatController } from './god-chat.controller';
import { GodChatService } from './god-chat.service';
import { GodChatSessionsService } from './god-chat-sessions.service';
import { LlmClient } from './llm.client';

@Module({
  controllers: [GodChatController, AdminGodChatController],
  providers: [GodChatService, GodChatSessionsService, LlmClient],
})
export class GodChatModule {}
