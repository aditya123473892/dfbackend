import {
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
  Body,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { AuthUser } from 'src/common/decorators';
import { JwtAuthGuard } from 'src/common/guards';
import { IAuthUser } from 'src/common/interfaces';
import { successGetRes, successRes } from 'src/common/interceptors/response.handlers';
import { ChatService } from './chats.service';
import {
  ChatMediaQueryDto,
  CreateChatMessageDto,
  UpdateChatMediaExpiryDto,
} from './dto/create-chat-message.dto';
import { ChatGateway } from './chats.gateway';

@ApiTags('Chats')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('chats')
export class ChatsController {
  constructor(
    private readonly chatService: ChatService,
    private readonly chatGateway: ChatGateway,
  ) {}

  /** Direct and group conversations with last message and unread count, newest first. */
  @Get('conversations')
  async listConversations(@AuthUser() user: IAuthUser) {
    return successGetRes({ conversations: await this.chatService.getConversations(user.id) });
  }

  @Post('groups/:groupId/read')
  async markGroupRead(@AuthUser() user: IAuthUser, @Param('groupId') groupId: string) {
    return successRes(await this.chatService.markGroupAsRead(user.id, groupId));
  }

  @Post('messages')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FilesInterceptor('media', Number(process.env.CHAT_MEDIA_MAX_ATTACHMENTS || 5), {
      limits: { fileSize: Number(process.env.CHAT_MEDIA_MAX_FILE_SIZE || 25 * 1024 * 1024) },
    }),
  )
  async createMessage(
    @AuthUser() user: IAuthUser,
    @Body() dto: CreateChatMessageDto,
    @UploadedFiles() files: Express.Multer.File[] = [],
  ) {
    const message = await this.chatService.createMediaMessage(user.id, dto, files);
    this.chatGateway.broadcastSavedMessage(message);
    return successRes(message, 'Message sent');
  }

  @Post('messages/:messageId/media/:mediaId/access-url')
  async getAccessUrl(
    @AuthUser() user: IAuthUser,
    @Param('messageId') messageId: string,
    @Param('mediaId') mediaId: string,
  ) {
    const { message, ...access } = await this.chatService.getMediaAccessUrl(
      user.id,
      messageId,
      mediaId,
    );
    // Opening view-once media updates the message for both participants.
    if (message) this.chatGateway.broadcastSavedMessage(message, 'messageUpdated');
    return successGetRes(access);
  }

  @Patch('messages/:messageId/media/:mediaId/revoke')
  async revokeMedia(
    @AuthUser() user: IAuthUser,
    @Param('messageId') messageId: string,
    @Param('mediaId') mediaId: string,
  ) {
    const message = await this.chatService.revokeMedia(user.id, messageId, mediaId);
    this.chatGateway.broadcastSavedMessage(message, 'messageUpdated');
    return successRes(message, 'Media revoked');
  }

  @Patch('messages/:messageId/media/:mediaId/expiration')
  async updateExpiration(
    @AuthUser() user: IAuthUser,
    @Param('messageId') messageId: string,
    @Param('mediaId') mediaId: string,
    @Body() dto: UpdateChatMediaExpiryDto,
  ) {
    const message = await this.chatService.updateMediaExpiration(
      user.id,
      messageId,
      mediaId,
      dto.expiresAt,
    );
    this.chatGateway.broadcastSavedMessage(message, 'messageUpdated');
    return successRes(message, 'Media expiration updated');
  }

  @Get('media')
  async listConversationMedia(
    @AuthUser() user: IAuthUser,
    @Query() query: ChatMediaQueryDto,
  ) {
    return successGetRes(await this.chatService.listConversationMedia(user.id, query));
  }
}
