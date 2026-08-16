import { Module } from '@nestjs/common';
import {
  ServersController,
  ServerTemplatesController,
} from './servers.controller';
import { ServersService } from './servers.service';

@Module({
  controllers: [ServersController, ServerTemplatesController],
  providers: [ServersService],
  exports: [ServersService],
})
export class ServersModule {}
