import { ApiProperty, OmitType } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, IsByteLength } from 'class-validator';
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
  'firstName',
  'lastName',
  'age',
  'gender',
  'password',
] as const) {
  @IsString()
  @IsByteLength(8, 72)
  @Matches(/^(?=.*[A-Z])(?=.*[0-9])[\s\S]+$/, { message: 'Password needs an uppercase letter and a number' })
  password: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  lastName?: string;

  @IsOptional()
  age?: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  gender?: string;

  @ApiProperty({ description: 'From POST /auth/otp/signup/verify' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  signupToken: string;
}

export class PasswordLoginDto {
  @ApiProperty({ description: 'Email or mobile number with country code' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(254)
  identifier: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  password: string;
}
