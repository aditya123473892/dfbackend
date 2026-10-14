import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { successRes } from './response.handlers';

@Catch()
export default class GlobalExceptionFilter implements ExceptionFilter {
  catch(error: any, host: ArgumentsHost) {
    Logger.error(`GlobalExceptionFilter: ${error.message}`);

    // Return success response when status code is 200
    if (error?.response?.status === 200) {
      return successRes({ message: error?.response?.response });
    }

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const status =
      error?.response?.statusCode || HttpStatus.INTERNAL_SERVER_ERROR;

    response.status(status).json({
      statusCode: status,
      error: error?.response?.error || error.name,
      message: error?.response?.message
        ? error?.response?.message
        : error.message || 'Internal Server Error',
    });
  }
}
