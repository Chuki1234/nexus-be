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

import { ServerRolesService } from './server-roles.service';

@Module({
  imports: [RealtimeModule],
  controllers: [
    ServersController,
    ServerTemplatesController,
    ServerInvitationsController,
    InvitesController,
  ],
  providers: [
    ServersService,
    ServerPermissionsService,
    ServerInvitesService,
    ServerRolesService,
  ],
  exports: [
    ServersService,
    ServerPermissionsService,
    ServerInvitesService,
    ServerRolesService,
  ],
})
export class ServersModule {}
