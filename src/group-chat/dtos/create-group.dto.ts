import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export const MAX_GROUP_MEMBERS = Number(process.env.GROUP_MAX_MEMBERS || 256);
export const MAX_GROUP_NAME_LENGTH = 100;
export const MAX_GROUP_DESCRIPTION_LENGTH = 500;

export class CreateGroupDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_GROUP_NAME_LENGTH)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_GROUP_DESCRIPTION_LENGTH)
  description?: string;

  // Ignored: the owner is always the authenticated user. Kept so existing
  // clients that send it are not rejected.
  @IsMongoId()
  @IsOptional()
  admin?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_GROUP_MEMBERS - 1)
  @IsMongoId({ each: true })
  members: string[];

  // Idempotency key generated once per create attempt and reused on retries.
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{8,64}$/)
  clientId?: string;
}
