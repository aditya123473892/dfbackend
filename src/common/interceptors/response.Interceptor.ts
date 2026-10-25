import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  StreamableFile,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface Response<T> {
  statusCode: number;
  message: string;
  data: T;
}

@Injectable()
export default class ResponseInterceptor<T> implements NestInterceptor<
  T,
  Response<T>
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<Response<T>> {
    return next.handle().pipe(
      map((data) => {
        if (data instanceof StreamableFile) return data as any;
        const response = context.switchToHttp().getResponse();
        const statusCode =
          data?.statusCode >= 400 ? data.statusCode : response.statusCode;
        response.status(statusCode);
        return {
          ...data,
          statusCode,
          reqId: context.switchToHttp().getRequest().reqId,
        };
      }),
    );
  }
}
