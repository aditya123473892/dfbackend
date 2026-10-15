import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as dotenv from 'dotenv';
import { ResponseInterceptor } from './common/interceptors';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

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

  // Unique indexes back idempotent sends/creates and one-like-per-user, so
  // they must exist before traffic arrives (Mongoose builds them
  // asynchronously). A failed build is logged rather than fatal; duplicate
  // legacy likes are fixed with `npm run db:repair-post-interactions`.
  const connection = app.get<Connection>(getConnectionToken());
  const models = Object.values(connection.models);
  const builds = await Promise.allSettled(models.map((model) => model.init()));
  builds.forEach((result, index) => {
    if (result.status === 'rejected') {
      Logger.error(`Index build failed for ${models[index].modelName}: ${result.reason?.message}`);
    }
  });

  await app.listen(configService.get<string>('PORT'));
  Logger.log(`Services running at PORT ${configService.get<string>('PORT')}`);
}
bootstrap();
