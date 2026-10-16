import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ChatGateway } from './chats.gateway';
import { ChatService } from './chats.service';

/**
 * Removes disappearing messages after their timer and the stored files of
 * opened view-once media. Reads already hide expired messages, so this only
 * reclaims storage and tells connected clients.
 */
@Injectable()
export class ChatExpiryService {
  private readonly logger = new Logger(ChatExpiryService.name);
  private running = false;

  constructor(
    private readonly chatService: ChatService,
    private readonly chatGateway: ChatGateway,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async sweep(now = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      for (const message of await this.chatService.purgeExpiredMessages(now)) {
        this.chatGateway.broadcastSavedMessage(
          { ...message, messageId: String(message._id) },
          'messageDeleted',
        );
      }
      for (const message of await this.chatService.purgeOpenedViewOnceMedia(now)) {
        this.chatGateway.broadcastSavedMessage(message, 'messageUpdated');
      }
    } catch (error) {
      this.logger.error(`Chat expiry sweep failed: ${error?.message || error}`);
    } finally {
      this.running = false;
    }
  }
}
