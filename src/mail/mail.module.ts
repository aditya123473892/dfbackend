import { Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { MailController } from './mail.controller';
import {
  DatabaseHandlebarsAdapter,
  FileHandlebarsAdapter,
} from 'src/common/adapters';

@Module({
  controllers: [MailController],
  providers: [MailService, DatabaseHandlebarsAdapter, FileHandlebarsAdapter],
  exports: [MailService, DatabaseHandlebarsAdapter, FileHandlebarsAdapter],
})
export class MailModule {}
