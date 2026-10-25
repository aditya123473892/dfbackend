import { Prop, Schema } from '@nestjs/mongoose';

export enum ChatMediaStatus {
  ACTIVE = 'active',
  REVOKED = 'revoked',
  QUARANTINED = 'quarantined',
}

@Schema({ _id: true })
export class Media {
  @Prop({ select: false }) previewKey?: string;
  @Prop() photoId?: string;
  @Prop() blurhash?: string;
  @Prop() width?: number;
  @Prop() height?: number;

  @Prop() ownerId?: string;
  @Prop() resourceType?: string;
  @Prop() resourceId?: string;
  @Prop({ select: false }) s3Key?: string;
  @Prop() conversationId?: string;
  @Prop() messageId?: string;
  @Prop() storageLayoutVersion?: number;
  @Prop() contentType?: string;

  @Prop({ required: false })
  mimetype: string;

  @Prop({ required: false })
  url: string;

  @Prop({ required: false })
  originalname: string;

  @Prop({ required: false })
  filename: string;

  @Prop({ required: false, select: false })
  storageKey?: string;

  @Prop({ required: false })
  size?: number;

  @Prop({ required: false })
  checksum?: string;

  @Prop({
    type: String,
    enum: ChatMediaStatus,
    default: ChatMediaStatus.ACTIVE,
  })
  status?: ChatMediaStatus;

  @Prop({ type: Date, required: false })
  expiresAt?: Date;

  @Prop({ type: Date, required: false })
  revokedAt?: Date;
}
