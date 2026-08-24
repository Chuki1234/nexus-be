import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { ServerInvitesService } from './server-invites.service';
import { ServerPermissionsService } from './server-permissions.service';
import {
  InvitesController,
  ServerInvitationsController,
  ServersController,
  ServerTemplatesController,
} from './servers.controller';
import { ServersService } from './servers.service';

@Module({
  imports: [RealtimeModule],
  controllers: [
    ServersController,
    ServerTemplatesController,
    ServerInvitationsController,
    InvitesController,
  ],
  providers: [ServersService, ServerPermissionsService, ServerInvitesService],
  exports: [ServersService, ServerPermissionsService, ServerInvitesService],
})
export class ServersModule {}
