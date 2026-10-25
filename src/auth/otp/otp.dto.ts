import { ApiProperty, OmitType } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { CreateUserDto } from 'src/users/dtos';

export class SendOtpDto {
  @ApiProperty({ example: '+919876543210', description: 'E.164, or a national number (OTP_DEFAULT_COUNTRY)' })
  @IsString()
  @MaxLength(32)
  phone: string;

  @ApiProperty({ enum: ['login', 'signup'], required: false, default: 'login' })
  @IsOptional()
  @IsIn(['login', 'signup'])
  purpose?: 'login' | 'signup';
}

export class PhoneDto {
  @ApiProperty({ example: '+919876543210' })
  @IsString()
  @MaxLength(32)
  phone: string;
}

export class VerifyOtpDto extends PhoneDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  @Matches(/^\d{4,10}$/, { message: 'code must be the digits from the SMS' })
  code: string;
}

export class OtpSignupDto extends OmitType(CreateUserDto, [
  'phoneNumber',
  'roles',
  'displayname',
  'isEmailVerified',
  'passwordResetToken',
  'passwordResetTokenUsed',
] as const) {
  @ApiProperty({ description: 'From POST /auth/otp/signup/verify' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  signupToken: string;
}
