import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { mergeMap } from 'rxjs/operators';
import { PhotosService } from './photos.service';

/** Sign only while producing an already-authorized response; never persist URLs. */
@Injectable()
export class PhotoResponseInterceptor implements NestInterceptor {
  constructor(private readonly photos: PhotosService) {}
  intercept(context: ExecutionContext, next: CallHandler) {
    // Moderation has its own case authorization, evidence signing and streaming.
    // Never feed case snapshots or restricted bytes through social presentation.
    if (context.getClass()?.name === 'ModController') return next.handle();
    const http = context.switchToHttp();
    const user = http.getRequest().user;
    // One policy for feed/profile/mutation/nested responses, including signed URLs.
    http.getResponse().setHeader('Cache-Control', 'private, no-store');
    const adminPosts = context.getClass()?.name === 'AdminPostsController' &&
      user?.roles?.some((role: string) => ['admin', 'root'].includes(role));
    return next.handle().pipe(mergeMap((value) => this.photos.present(value, user?.id, undefined, !!adminPosts)));
  }
}
