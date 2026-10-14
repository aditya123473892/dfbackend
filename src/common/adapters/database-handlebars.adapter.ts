// handlebars.adapter.ts
import { Injectable } from '@nestjs/common';
import * as handlebars from 'handlebars';
// import { EmailTemplatesService } from 'src/email-templates/email-templates.service';

// @Injectable()
// export class DatabaseHandlebarsAdapter {
//   constructor(private readonly emailTemplatesService: EmailTemplatesService) {}

//   async compile(_id: string, context: any): Promise<string> {
//     const template = await this.emailTemplatesService.findById(_id);
//     if (!template) {
//       throw new Error(`Template not found: ${_id}`);
//     }

//     const compiledTemplate = handlebars.compile(template.content);
//     return compiledTemplate(context);
//   }
// }

@Injectable()
export class DatabaseHandlebarsAdapter {}
