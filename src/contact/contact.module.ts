import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Contact, ContactSchema } from '../common/schemas/contact.schema';
import { ContactService } from './contact.service';
import { ContactController } from './contact.controller';
import { MailModule } from 'src/mail/mail.module';
import { UsersModule } from 'src/users/users.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Contact.name, schema: ContactSchema }]),
    MailModule,
    UsersModule,
  ],
  controllers: [ContactController],
  providers: [ContactService],
//   exports: [ContactService],
})
export class ContactModule {}