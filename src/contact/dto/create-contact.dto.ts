import {
  IsString,
  IsNotEmpty,
  IsEmail,
} from 'class-validator';

export class CreateContactDto {
  @IsString()
  @IsNotEmpty()
  name: string;     

// @IsString()
// @IsNotEmpty()
// phone: string;

  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  message: string;


}