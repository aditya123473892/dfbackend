import { BadRequestException, ValidationError, ValidationPipe } from '@nestjs/common';

/** `{ "members.0": ["members must be a mongodb id"] }`; nested fields use dotted paths. */
export function fieldErrors(errors: ValidationError[], parent = ''): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const error of errors) {
    const path = parent ? `${parent}.${error.property}` : error.property;
    if (error.constraints) result[path] = Object.values(error.constraints);
    Object.assign(result, fieldErrors(error.children || [], path));
  }
  return result;
}

/**
 * `message` keeps Nest's default list of messages for existing clients;
 * `errors` adds the same messages grouped by field.
 */
export function applicationValidationPipe() {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    exceptionFactory: (errors) => {
      const errorsByField = fieldErrors(errors);
      return new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: Object.values(errorsByField).flat(),
        errors: errorsByField,
      });
    },
  });
}
