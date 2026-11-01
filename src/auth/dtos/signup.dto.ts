import { OmitType } from '@nestjs/swagger';
import { CreateUserDto } from 'src/users/dtos';
import { IsOptional, IsString, MaxLength } from 'class-validator';

// Public signup accepts profile fields only; account privileges are server managed.
export class SignupDto extends OmitType(CreateUserDto, [
  'roles',
  'displayname',
  'isEmailVerified',
  'passwordResetToken',
  'passwordResetTokenUsed',
] as const) {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phoneNumber?: string;
}
