import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { StorageModule } from '../../infra/storage/storage.module';
import { ServerInvitesService } from './server-invites.service';
import { ServerPermissionsService } from './server-permissions.service';
import {
  InvitesController,
  ServerInvitationsController,
  ServerPreviewController,
  ServersController,
  ServerTemplatesController,
} from './servers.controller';
import { ServersService } from './servers.service';

import { ServerRolesService } from './server-roles.service';

@Module({
  imports: [RealtimeModule, StorageModule],
  controllers: [
    ServersController,
    ServerTemplatesController,
    ServerInvitationsController,
    InvitesController,
    ServerPreviewController,
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
