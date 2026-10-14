import { ApiHideProperty, ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
} from 'class-validator';
import { ERole } from 'src/common/enums';

export class CreateUserDto {
  @ApiProperty()
  @IsNotEmpty()
  @IsEmail()
  username: string;

  @ApiProperty()
  @IsNotEmpty()
  password: string;

  @ApiProperty()
  @IsNotEmpty()
  firstName: string;

  @ApiProperty()
  @IsNotEmpty()
  lastName: string;

  @ApiProperty()
  @IsOptional()
  phoneNumber?: string;

  @ApiProperty()
  @IsNotEmpty()
  age: number;

  @ApiProperty()
  @IsNotEmpty()
  gender: string;

  displayname?: string;

  @ApiProperty({ enum: ERole, isArray: true, default: [ERole.USER] })
  @IsArray()
  @IsEnum(ERole, { each: true })
  roles: ERole[];

  @ApiHideProperty()
  isEmailVerified: boolean;

  @ApiHideProperty()
  passwordResetToken: string;

  @ApiHideProperty()
  passwordResetTokenUsed: boolean;
}
