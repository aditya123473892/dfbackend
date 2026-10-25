import { Module } from '@nestjs/common';
import { GodChatController } from './god-chat.controller';
import { GodChatService } from './god-chat.service';
import { LlmClient } from './llm.client';

@Module({
  controllers: [GodChatController],
  providers: [GodChatService, LlmClient],
})
export class GodChatModule {}
