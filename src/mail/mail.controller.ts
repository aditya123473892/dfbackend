import { Controller, Post } from '@nestjs/common';
import { MailService } from './mail.service';
import { successRes } from 'src/common/interceptors';
import { ApiTags } from '@nestjs/swagger';

@ApiTags('Mail')
@Controller('mail')
export class MailController {
  constructor(private readonly mailService: MailService) {}

  @Post('send')
  async sendEmail() {
    const mail = await this.mailService.test(
      'jfriday464@gmail.com',
      'Shashank Dubey',
      '',
    );

    return successRes(mail);
  }
}
