import * as AWS from 'aws-sdk';
import { FileHandlebarsAdapter } from 'src/common/adapters';
import { Injectable } from '@nestjs/common';
import { ETemplateEmail } from 'src/common/enums';

@Injectable()
export class MailService {
  constructor(private readonly fileHandlebarsAdapter: FileHandlebarsAdapter) {}

  /**
   * Send email to influencer for new client
   * @param {string} to - influencer email id
   * @param {string} name - Influencer information
   * @returns {Promise<any | null>} Returns mail response from AWS SES
   */
  async test(to: string, name: string, url: string) {
    try {
      // Mock if AWS credentials are missing
      if (!process.env.AWS_ACCESS_KEY || !process.env.AWS_SECRET || !process.env.AWS_SES_REGION) {
        return { MessageId: "mock-message-id" };
      }
      const AWS_MAIL_FROM = process.env.AWS_MAIL_FROM;

      const awsConfig = {
        accessKeyId: process.env.AWS_ACCESS_KEY,
        secretAccessKey: process.env.AWS_SECRET,
        region: process.env.AWS_SES_REGION,
      };

      const html = await this.fileHandlebarsAdapter.compile(
        ETemplateEmail.RESET_PASSWORD,
        {
          name,
          url,
        },
      );

      const params = {
        Source: `Dark Fantasy<${AWS_MAIL_FROM}>`,
        Destination: {
          ToAddresses: [to],
        },
        Message: {
          Subject: {
            Charset: 'UTF-8',
            Data: 'Thank You for Registering',
          },
          Body: {
            Html: {
              Charset: 'UTF-8',
              Data: html,
            },
          },
        },
      };

      const SES = new AWS.SES(awsConfig);

      const sendMail = await SES.sendEmail(params).promise();

      return sendMail;
    } catch (error) {
      console.log('log: error', error);
      throw new Error(error);
    }
  }

  /**
   * Send email to user for new client
   * @param {string} to - user's email id
   * @param {string} name - user's name
   * @param {string} url - URL for verify account
   * @returns {Promise<any | null>} Returns mail response from AWS SES
   */
  async verifyAccount(to: string, name: string) {
    try {
      // Mock if AWS credentials are missing
      if (!process.env.AWS_ACCESS_KEY || !process.env.AWS_SECRET || !process.env.AWS_SES_REGION) {
        return { MessageId: "mock-message-id" };
      }
      const AWS_MAIL_FROM = process.env.AWS_MAIL_FROM;

      const awsConfig = {
        accessKeyId: process.env.AWS_ACCESS_KEY,
        secretAccessKey: process.env.AWS_SECRET,
        region: process.env.AWS_SES_REGION,
      };

      const html = await this.fileHandlebarsAdapter.compile(
        ETemplateEmail.VERIFY_ACCOUNT,
        {
          name
        },
      );

      const params = {
        Source: `Dark Fantasy<${AWS_MAIL_FROM}>`,
        Destination: {
          ToAddresses: [to],
        },
        Message: {
          Subject: {
            Charset: 'UTF-8',
            Data: 'Verify your account',
          },
          Body: {
            Html: {
              Charset: 'UTF-8',
              Data: html,
            },
          },
        },
      };

      const SES = new AWS.SES(awsConfig);

      const sendMail = await SES.sendEmail(params).promise();

      return sendMail;
    } catch (error) {
      console.log('log: error', error);
      throw new Error(error);
    }
  }

  /**
   * Send email to user for new client
   * @param {string} to - user's email id
   * @param {string} name - user's name
   * @param {string} url - URL for verify account
   * @returns {Promise<any | null>} Returns mail response from AWS SES
   */
  async resetPassword(to: string, name: string, url: string) {
    try {
      // Mock if AWS credentials are missing
      if (!process.env.AWS_ACCESS_KEY || !process.env.AWS_SECRET || !process.env.AWS_SES_REGION) {
        return { MessageId: "mock-message-id" };
      }
      const AWS_MAIL_FROM = process.env.AWS_MAIL_FROM;

      const awsConfig = {
        accessKeyId: process.env.AWS_ACCESS_KEY,
        secretAccessKey: process.env.AWS_SECRET,
        region: process.env.AWS_SES_REGION,
      };

      const html = await this.fileHandlebarsAdapter.compile(
        ETemplateEmail.RESET_PASSWORD,
        {
          name,
          url,
        },
      );

      const params = {
        Source: `Dark Fantasy<${AWS_MAIL_FROM}>`,
        Destination: {
          ToAddresses: [to],
        },
        Message: {
          Subject: {
            Charset: 'UTF-8',
            Data: 'Reset Password',
          },
          Body: {
            Html: {
              Charset: 'UTF-8',
              Data: html,
            },
          },
        },
      };

      const SES = new AWS.SES(awsConfig);

      const sendMail = await SES.sendEmail(params).promise();

      return sendMail;
    } catch (error) {
      console.log('log: error', error);
      throw new Error(error);
    }
  }

    /**
   * Send email to user for new client
   * @param {string} to - user's email id
   * @param {string} name - user's name
   * @param {string} url - URL for verify account
   * @param {string} status - account status
   * @returns {Promise<any | null>} Returns mail response from AWS SES
   */

  async verifyAccountByAdmin(to: string, name: string, status: string, url: string) {
    try {
      // Mock if AWS credentials are missing
      if (!process.env.AWS_ACCESS_KEY || !process.env.AWS_SECRET || !process.env.AWS_SES_REGION) {
        return { MessageId: "mock-message-id" };
      }
      const AWS_MAIL_FROM = process.env.AWS_MAIL_FROM;
      const awsConfig = {
        accessKeyId: process.env.AWS_ACCESS_KEY,
        secretAccessKey: process.env.AWS_SECRET,
        region: process.env.AWS_SES_REGION,
      };
  
      let template;
      if (status === 'accepted') {
        template = ETemplateEmail.ACCOUNT_VERIFIED;
      } else {
        template = ETemplateEmail.ACCOUNT_REJECT;
      }
  
      const html = await this.fileHandlebarsAdapter.compile(template, {
        name,
        loginUrl: url
      });
  
      const params = {
        Source: `Dark Fantasy<${AWS_MAIL_FROM}>`,
        Destination: {
          ToAddresses: [to],
        },
        Message: {
          Subject: {
            Charset: 'UTF-8',
            Data: status === 'accepted' ? 'Account Verified' : 'Account Verification Rejected',
          },
          Body: {
            Html: {
              Charset: 'UTF-8',
              Data: html,
            },
          },
        },
      };
  
      const SES = new AWS.SES(awsConfig);
      const sendMail = await SES.sendEmail(params).promise();
  
      return sendMail;
    } catch (error) {
      console.log('log: error', error);
      throw new Error(error);
    }
  }

  

  async sendCreateEventMailForAllUser(to: string, name: string,url:string) {
    try {
      // Mock if AWS credentials are missing
      if (!process.env.AWS_ACCESS_KEY || !process.env.AWS_SECRET || !process.env.AWS_SES_REGION) {
        return { MessageId: "mock-message-id" };
      }
      const AWS_MAIL_FROM = process.env.AWS_MAIL_FROM;

      const awsConfig = {
        accessKeyId: process.env.AWS_ACCESS_KEY,
        secretAccessKey: process.env.AWS_SECRET,
        region: process.env.AWS_SES_REGION,
      };

      const html = await this.fileHandlebarsAdapter.compile(
        ETemplateEmail.CREATE_EVENT,
        {
          name,
          url
        },
      );

      const params = {
        Source: `Dark Fantasy<${AWS_MAIL_FROM}>`,
        Destination: {
          ToAddresses: [to],
        },
        Message: {
          Subject: {
            Charset: 'UTF-8',
            Data: 'New event created and ready for you!',
          },
          Body: {
            Html: {
              Charset: 'UTF-8',
              Data: html,
            },
          },
        },
      };

      const SES = new AWS.SES(awsConfig);

      const sendMail = await SES.sendEmail(params).promise();

      return sendMail;
    } catch (error) {
      console.log('log: error', error);
      throw new Error(error);
    }
  }
  async sendCreateSubscriptionMailForAllUser(to: string, name: string,url:string,plan:string,description:string,price:number) {
    try {
      // Mock if AWS credentials are missing
      if (!process.env.AWS_ACCESS_KEY || !process.env.AWS_SECRET || !process.env.AWS_SES_REGION) {
        return { MessageId: "mock-message-id" };
      }
      const AWS_MAIL_FROM = process.env.AWS_MAIL_FROM;

      const awsConfig = {
        accessKeyId: process.env.AWS_ACCESS_KEY,
        secretAccessKey: process.env.AWS_SECRET,
        region: process.env.AWS_SES_REGION,
      };

      const html = await this.fileHandlebarsAdapter.compile(
        ETemplateEmail.CREATE_SUBSCRIPTION,
        {
          name,
          url,
          plan,
          description,
          price
        },
      );

      const params = {
        Source: `Dark Fantasy<${AWS_MAIL_FROM}>`,
        Destination: {
          ToAddresses: [to],
        },
        Message: {
          Subject: {
            Charset: 'UTF-8',
            Data: 'New subscription created and ready for you! ',
          },
          Body: {
            Html: {
              Charset: 'UTF-8',
              Data: html,
            },
          },
        },
      };

      const SES = new AWS.SES(awsConfig);

      const sendMail = await SES.sendEmail(params).promise();

      return sendMail;
    } catch (error) {
      console.log('log: error', error);
      throw new Error(error);
    }
  }


  async sendSubscriptionMessage(to: string, name:string, message: string, url:string, coupons: any[]) {
    try {
      // Mock if AWS credentials are missing
      if (!process.env.AWS_ACCESS_KEY || !process.env.AWS_SECRET || !process.env.AWS_SES_REGION) {
        return { MessageId: "mock-message-id" };
      }
      const AWS_MAIL_FROM = process.env.AWS_MAIL_FROM;

      const awsConfig = {
        accessKeyId: process.env.AWS_ACCESS_KEY,
        secretAccessKey: process.env.AWS_SECRET,
        region: process.env.AWS_SES_REGION,
      };

      const html = await this.fileHandlebarsAdapter.compile(
        ETemplateEmail.LIMITED_MESSAGE,
        {
          name,
          message,
          url,
          coupons: coupons.map(coupon => ({
            code: coupon.code,
            planName: coupon.subscription ? coupon.subscription.planName : 'No subscription plan available',
            discountValue: coupon.discountValue,
            discountType: coupon.discountType,
          })),
        },
      );

      const params = {
        Source: `Dark Fantasy<${AWS_MAIL_FROM}>`,
        Destination: {
          ToAddresses: [to],
        },
        Message: {
          Subject: {
            Charset: 'UTF-8',
            Data: 'Your daily message limit of 5 has been reached.',
          },
          Body: {
            Html: {
              Charset: 'UTF-8',
              Data: html,
            },
          },
        },
      };

      const SES = new AWS.SES(awsConfig);

      const sendMail = await SES.sendEmail(params).promise();

      return sendMail;
    } catch (error) {
      console.log('log: error', error);
      throw new Error(error);
    }
  }


  async sendContactMessage(to: string[] | string, contact: any) {
    try {
      // Mock if AWS credentials are missing
      if (!process.env.AWS_ACCESS_KEY || !process.env.AWS_SECRET || !process.env.AWS_SES_REGION) {
        return { MessageId: "mock-message-id" };
      }
      const AWS_MAIL_FROM = process.env.AWS_MAIL_FROM;

      const awsConfig = {
        accessKeyId: process.env.AWS_ACCESS_KEY,
        secretAccessKey: process.env.AWS_SECRET,
        region: process.env.AWS_SES_REGION,
      };

      const html = await this.fileHandlebarsAdapter.compile(
        ETemplateEmail.CONTACT_MESSAGE,
        {
          name: contact.name,
          email: contact.email,
          message: contact.message,
        },
      );

      const params = {
        Source: `Dark Fantasy<${AWS_MAIL_FROM}>`,
        Destination: {
          ToAddresses: Array.isArray(to) ? to : [to],
        },
        Message: {
          Subject: {
            Charset: 'UTF-8',
            Data: 'Contact us details',
          },
          Body: {
            Html: {
              Charset: 'UTF-8',
              Data: html,
            },
          },
        },
      };

      const SES = new AWS.SES(awsConfig);

      const sendMail = await SES.sendEmail(params).promise();

      return sendMail;
    } catch (error) {
      console.log('log: error', error);
      throw new Error(error);
    }
  }

   
}
