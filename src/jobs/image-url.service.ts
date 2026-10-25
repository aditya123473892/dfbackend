import { Injectable } from '@nestjs/common';
import { PhotosService } from '../photos/photos.service';

/** Compatibility entry point. Signed URLs are generated on authorized reads. */
@Injectable()
export class ImageURLService {
  constructor(private readonly photos: PhotosService) {}
  async regenerateSignedURL() {
    await this.photos.cleanup();
  }
}
