import { HttpException, HttpStatus } from '@nestjs/common';

export function res500(error, data?: any) {
  throw new HttpException(
    {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: error.name,
      message: error.message || 'Internal Server Error',
      data: data || null,
    },
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

export function duplicateRecordRes(message: string, data?: any) {
  return {
    statusCode: HttpStatus.CONFLICT,
    error: 'Duplicate Entry',
    message,
    data: data || null,
  };
}

export function badRequestRes(
  message: string,
  data?: any,
  error = 'Bad Request',
) {
  return {
    statusCode: HttpStatus.BAD_REQUEST,
    error,
    message,
    data: data || null,
  };
}

export function unAuthorizedRes(message?: string) {
  return {
    statusCode: HttpStatus.UNAUTHORIZED,
    error: 'Forbidden',
    message: message || 'Resource forbidden, access denied!',
  };
}

export function successRes(data?, message?: string) {
  return {
    data,
    statusCode: HttpStatus.CREATED,
    message: message || 'Success',
    error: false,
  };
}

export function successGetRes(data?, message?: string) {
  return {
    data,
    statusCode: HttpStatus.OK,
    message: message || 'Success',
    error: false,
  };
}