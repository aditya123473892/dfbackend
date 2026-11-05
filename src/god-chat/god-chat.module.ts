import { Module } from '@nestjs/common';
import { AdminGodChatController, GodChatController } from './god-chat.controller';
import { GodChatService } from './god-chat.service';
import { GodChatSessionsService } from './god-chat-sessions.service';
import { LlmClient } from './llm.client';
import { GodChatQuotaService } from './god-chat-quota.service';

@Module({
  controllers: [GodChatController, AdminGodChatController],
  providers: [GodChatService, GodChatSessionsService, GodChatQuotaService, LlmClient],
})
export class GodChatModule {}
