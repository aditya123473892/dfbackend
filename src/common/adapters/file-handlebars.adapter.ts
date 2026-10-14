// handlebars.adapter.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import * as handlebars from 'handlebars';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ETemplateEmail } from '../enums';

// @Injectable()
// export class FilebaseHandlebarsAdapter {
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
handlebars.registerHelper('ifEquals', function (a, b, options) {
  if (a === b) {
    return options.fn(this);
  }
  return options.inverse(this);
});

@Injectable()
export class FileHandlebarsAdapter {
  private readonly templatesDir = path.join(
    __dirname,
    '../../../../src/common/templates',
  );

  async compile(templateName: ETemplateEmail, context: any): Promise<string> {
    try {
      // Load the template file
      const templatePath = path.join(this.templatesDir, `${templateName}.hbs`);

      const templateContent = await fs.readFile(templatePath, 'utf8');

      // Compile the template
      const compiledTemplate = handlebars.compile(templateContent);

      // Render the template with the provided context
      return compiledTemplate(context);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new NotFoundException(`Template not found: ${templateName}`);
      }
      throw error;
    }
  }
}
