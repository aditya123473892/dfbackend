import { PartialType } from '@nestjs/swagger';
import { CreateUserDto } from 'src/users/dtos';

export class SignupDto extends PartialType(CreateUserDto) {}
