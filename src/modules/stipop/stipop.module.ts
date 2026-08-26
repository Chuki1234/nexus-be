import { Module } from '@nestjs/common';
import { StipopController } from './stipop.controller';
import { StipopService } from './stipop.service';

@Module({
  controllers: [StipopController],
  providers: [StipopService],
  exports: [StipopService],
})
export class StipopModule {}
