import { Controller, Get, Post } from '@nestjs/common';
// import { exec } from 'child_process';
import { AppService } from './app.service';
import { ApiTags } from '@nestjs/swagger';
import { successRes } from './common/interceptors';
// import * as fs from 'fs';

@ApiTags('App')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello() {
    return successRes({}, 'Server is running');
  }
  // @Post('/webhook/h8mbk6dy3d4s713b')
  // runWebhook() {
  //   return new Promise((resolve, reject) => {
  //     // Execute the shell script

  //     exec('/var/www/e.sh', (error, stdout, stderr) => {
  //       if (error) {
  //         // Write the error message to a log file
  //         fs.appendFile('/var/www/error.log', error.message, () => {});
  //         console.error(`Error executing shell script: ${error}`);
  //         reject('Internal Server Error');
  //       } else {
  //         fs.appendFile('/var/www/success.log', error.message, () => {});
  //         console.log(`Shell script output: ${stdout}`);
  //         resolve('Shell script executed successfully');
  //       }
  //     });
  //   });
  // }
}
