import { Injectable, Logger } from '@nestjs/common';
import * as AWS from 'aws-sdk';

@Injectable()
export class S3BucketService {
  private readonly logger = new Logger(S3BucketService.name);
  private readonly AWS_S3_BUCKET = process.env.AWS_DEFAULT_S3_BUCKET;
  s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET,
    region: process.env.AWS_S3_REGION,
  });

  async uploadFile(file, folder) {
    const { originalname } = file;

    const folderPath = folder.endsWith('/') ? folder : `${folder}/`;

    const fileBuffer = this.convertToBuffer(file.buffer);

    return await this.s3_upload(
      fileBuffer,
      this.AWS_S3_BUCKET,
      folderPath + this.getTimestampInSeconds() + '-' + originalname,
      file.mimetype,
    );
  }

  async uploadPrivateFile(file: Express.Multer.File, storageKey: string) {
    return this.s3_upload(
      this.convertToBuffer(file.buffer),
      this.AWS_S3_BUCKET,
      storageKey,
      file.mimetype,
    );
  }

  convertToBuffer(fileBuffer): Buffer {
    if (Buffer.isBuffer(fileBuffer)) {
      return fileBuffer;
    }
    return Buffer.from(fileBuffer);
  }

  async s3_upload(file, Bucket: string, name: string, mimetype: string) {
    try {
      const params = {
        Bucket: this.getBucket(Bucket),
        Key: name.trim(),
        Body: file,
        ContentType: mimetype,
        ContentDisposition: 'inline',
        CreateBucketConfiguration: {
          LocationConstraint: process.env.AWS_S3_REGION,
        },
      };

      return await this.s3.upload(params).promise();
    } catch (error) {
      this.logger.error(error?.message || error);
      return null;
    }
  }

  async getSignedURL(Key: string, Bucket?: string, expiresInSeconds?: number) {
    try {
      if (!Key) {
        console.log('Missing S3 object key');
        return null;
      }

      return await this.s3.getSignedUrlPromise('getObject', {
        Bucket: this.getBucket(Bucket),
        Key,
        Expires:
          expiresInSeconds ||
          Number(process.env.CHAT_MEDIA_URL_TTL_SECONDS || 120),
      });
    } catch (error) {
      this.logger.error(error?.message || error);
      return null;
    }
  }

  async deleteOne(Key: string, Bucket?: string) {
    try {
      return await this.s3
        .deleteObject({
          Bucket: this.getBucket(Bucket),
          Key,
        })
        .promise();
    } catch (error) {
      this.logger.error(error?.message || error);
      return null;
    }
  }

  getTimestampInSeconds() {
    return Math.floor(Date.now() / 1000).toString();
  }

  private getBucket(Bucket?: string): string {
    const bucket = Bucket || this.AWS_S3_BUCKET;

    if (!bucket) {
      throw new Error('AWS_DEFAULT_S3_BUCKET is not configured');
    }

    return bucket;
  }
}
