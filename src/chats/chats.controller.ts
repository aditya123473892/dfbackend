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
  ValidationPipe,
  Header,
  BadRequestException,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { AuthUser } from 'src/common/decorators';
import { JwtAuthGuard } from 'src/common/guards';
import { IAuthUser } from 'src/common/interfaces';
import {
  successGetRes,
  successRes,
} from 'src/common/interceptors/response.handlers';
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

  @Get('messages')
  async history(
    @AuthUser() user: IAuthUser,
    @Query(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })) query: ChatMediaQueryDto,
  ) {
    if (Boolean(query.receiver) === Boolean(query.groupId))
      throw new BadRequestException('Choose one conversation');
    const messages = query.groupId
      ? await this.chatService.getChatGroupHistory(user.id, query.groupId)
      : await this.chatService.getChatHistory(user.id, query.receiver);
    return successGetRes(messages);
  }

  @Post('messages')
  async createMessage(
    @AuthUser() user: IAuthUser,
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    dto: CreateChatMessageDto,
  ) {
    const message = await this.chatService.createMediaMessage(user.id, dto);
    await this.chatGateway.broadcastSavedMessage(message);
    return successRes(message, 'Message sent');
  }

  @Post('messages/:messageId/media/:mediaId/access-url')
  @Header('Cache-Control', 'private, no-store')
  async getAccessUrl(
    @AuthUser() user: IAuthUser,
    @Param('messageId') messageId: string,
    @Param('mediaId') mediaId: string,
  ) {
    return successGetRes(
      await this.chatService.getMediaAccessUrl(user.id, messageId, mediaId),
    );
  }

  @Post('messages/:messageId/media/:mediaId/open')
  @Header('Cache-Control', 'private, no-store')
  @Header('Pragma', 'no-cache')
  async openPhoto(
    @AuthUser() user: IAuthUser,
    @Param('messageId') messageId: string,
    @Param('mediaId') mediaId: string,
  ) {
    const result = await this.chatService.openRestrictedPhoto(
      user.id,
      messageId,
      mediaId,
    );
    await this.chatGateway.broadcastSavedMessage(
      result.message,
      'messageUpdated',
    );
    return successGetRes(result);
  }

  @Patch('messages/:messageId/media/:mediaId/revoke')
  async revokeMedia(
    @AuthUser() user: IAuthUser,
    @Param('messageId') messageId: string,
    @Param('mediaId') mediaId: string,
  ) {
    const message = await this.chatService.revokeMedia(
      user.id,
      messageId,
      mediaId,
    );
    await this.chatGateway.broadcastSavedMessage(message, 'messageUpdated');
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
    await this.chatGateway.broadcastSavedMessage(message, 'messageUpdated');
    return successRes(message, 'Media expiration updated');
  }

  @Get('media')
  async listConversationMedia(
    @AuthUser() user: IAuthUser,
    @Query() query: ChatMediaQueryDto,
  ) {
    return successGetRes(
      await this.chatService.listConversationMedia(user.id, query),
    );
  }
}
