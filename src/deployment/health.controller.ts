import { Controller, Get, ServiceUnavailableException, Header } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

@Controller('health')
export class HealthController {
  constructor(@InjectConnection() private readonly db: Connection) {}
  @Get('live')
  @Header('Cache-Control', 'no-store')
  live() { return { status: 'ok' }; }

  @Get('ready')
  @Header('Cache-Control', 'no-store')
  async ready() {
    try {
      if (this.db.readyState !== 1) throw new Error('Disconnected');
      await this.db.db.admin().command({ ping: 1 }, { timeoutMS: 3000 });
      return { status: 'ready' };
    } catch { throw new ServiceUnavailableException('Database is unavailable'); }
  }
}
