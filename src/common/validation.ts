import { ValidationPipe } from '@nestjs/common';

export function applicationValidationPipe() {
  return new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true });
}
