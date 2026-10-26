import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpStatus,
  Logger,
  HttpException,
} from '@nestjs/common';
import { Response } from 'express';
import { successRes } from './response.handlers';

@Catch()
export default class GlobalExceptionFilter implements ExceptionFilter {
  catch(error: any, host: ArgumentsHost) {
    Logger.error({
      event: 'request_failed',
      type: error?.constructor?.name || 'Error',
    });

    // Return success response when status code is 200
    if (error?.response?.status === 200) {
      return successRes({ message: error?.response?.response });
    }

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const status =
      error instanceof HttpException
        ? error.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    response.status(status).json({
      statusCode: status,
      error: error?.response?.error || error.name,
      message:
        status >= 500
          ? 'The server could not complete this request'
          : error?.response?.message
            ? error?.response?.message
            : error.message || 'Internal Server Error',
      // Field-level validation details (see applicationValidationPipe).
      ...(status < 500 && error?.response?.errors ? { errors: error.response.errors } : {}),
    });
  }
}
