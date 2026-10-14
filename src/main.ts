import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as dotenv from 'dotenv';
import { ResponseInterceptor } from './common/interceptors';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  dotenv.config(); // Load environment variables from .env file
  const configService = new ConfigService();
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');

  //Middlewares
  const allowedOrigins = [
    ...(configService.get<string>('FRONTEND_ORIGIN') || '').split(','),
    configService.get<string>('PUBLIC_SITE_DOMAIN'),
    configService.get<string>('ADMIN_SITE_DOMAIN'),
  ]
    .map((origin) => origin?.trim().replace(/\/$/, ''))
    .filter(Boolean);
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin.replace(/\/$/, ''))) {
        return callback(null, true);
      }
      return callback(new Error('Origin is not allowed'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // app.setGlobalPrefix('v1');

  // Swagger Initialization
  const config = new DocumentBuilder()
    .setTitle('Dark Fantacy')
    .setDescription('Dark Fantacy backend APIs')
    .setVersion('1.0')
    .addBearerAuth()
    .addTag('Dark Fantacy')
    .build();

  const document = SwaggerModule.createDocument(app, config);

  // if (process.env.NODE_ENV !== 'production')
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  });

  // Global response interceptor
  app.useGlobalInterceptors(new ResponseInterceptor());

  // Using global validation pips for dtos
  app.useGlobalPipes(new ValidationPipe());

  await app.listen(configService.get<string>('PORT'));
  Logger.log(`Services running at PORT ${configService.get<string>('PORT')}`);
}
bootstrap();
