import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'shashank@gmail.com' })
  @IsEmail()
  username: string;

  @ApiProperty({ example: 'Test1234@' })
  @IsNotEmpty()
  password: string;
}
