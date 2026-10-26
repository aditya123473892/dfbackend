import { Global, Module } from '@nestjs/common';
import { BlockService } from './block.service';
import { UserBlocksController } from './user-blocks.controller';
@Global()
@Module({
  providers: [BlockService],
  controllers: [UserBlocksController],
  exports: [BlockService],
})
export class UserBlocksModule {}
