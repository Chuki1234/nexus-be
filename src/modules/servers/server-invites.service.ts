import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import {
  DirectServerInvitationDto,
  ServerInviteCandidateDto,
  ServerInviteLinkResponseDto,
  ServerInvitePreviewDto,
  ServerInviteStatus,
} from '../../shared/dto/server-invitations.dto';
import { ChatGateway } from '../realtime/chat.gateway';
import { CreateInviteLinkDto } from './dto/create-invite.dto';
import { ServerPermissionsService } from './server-permissions.service';
import type { ServerMemberDto } from '../../shared/dto/server-members.dto';

@Injectable()
export class ServerInvitesService {
  private readonly logger = new Logger(ServerInvitesService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly permissionsService: ServerPermissionsService,
    private readonly chatGateway: ChatGateway,
  ) {}

  /**
   * Lấy danh sách bạn bè đã chấp nhận (accepted friends) của user chưa tham gia server.
   */
  async getInviteCandidates(
    userId: string,
    serverId: string,
  ): Promise<ServerInviteCandidateDto[]> {
    await this.permissionsService.assertCanInvite(userId, serverId);

    // 1. Query danh sách bạn bè accepted từ bảng friendships
    const { data: friendships, error: friendError } = await this.supabase.client
      .from('friendships')
      .select('user_a_id, user_b_id')
      .or(`user_a_id.eq.${userId},user_b_id.eq.${userId}`)
      .eq('status', 'accepted');

    if (friendError) {
      this.logger.error(`Lấy danh sách bạn bè thất bại: ${friendError.message}`);
      throw new InternalServerErrorException('Không lấy được danh sách bạn bè.');
    }

    if (!friendships || friendships.length === 0) {
      return [];
    }

    const friendIds = friendships.map((f: { user_a_id: string; user_b_id: string }) =>
      f.user_a_id === userId ? f.user_b_id : f.user_a_id,
    );

    // 2. Lọc các bạn bè đã là thành viên trong server_members
    const { data: members, error: memberError } = await this.supabase.client
      .from('server_members')
      .select('user_id')
      .eq('server_id', serverId)
      .in('user_id', friendIds);

    if (memberError) {
      this.logger.error(`Lọc server members thất bại: ${memberError.message}`);
      throw new InternalServerErrorException('Lỗi kiểm tra thành viên máy chủ.');
    }

    const existingMemberIds = new Set(
      (members || []).map((m: { user_id: string }) => m.user_id),
    );
    const candidateIds = friendIds.filter((id) => !existingMemberIds.has(id));

    if (candidateIds.length === 0) {
      return [];
    }

    // 3. Lấy thông tin profile của các ứng viên
    const { data: profiles, error: profileError } = await this.supabase.client
      .from('profiles')
      .select('id, username, display_name, avatar_url')
      .in('id', candidateIds);

    if (profileError) {
      this.logger.error(`Lấy thông tin profile thất bại: ${profileError.message}`);
      throw new InternalServerErrorException('Lỗi lấy thông tin người dùng.');
    }

    return (profiles || []).map((p: any) => ({
      userId: p.id,
      username: p.username,
      displayName: p.display_name || p.username,
      avatarUrl: p.avatar_url ?? null,
      status: 'offline',
    }));
  }

  /**
   * Tạo lời mời trực tiếp tới một người bạn.
   */
  async createDirectInvitation(
    userId: string,
    serverId: string,
    inviteeId: string,
  ): Promise<DirectServerInvitationDto> {
    await this.permissionsService.assertCanInvite(userId, serverId);

    if (inviteeId === userId) {
      throw new BadRequestException('Không thể tự gửi lời mời cho chính mình.');
    }

    // Kiểm tra có phải bạn bè accepted không
    const { data: friendship, error: friendError } = await this.supabase.client
      .from('friendships')
      .select('status')
      .or(
        `and(user_a_id.eq.${userId},user_b_id.eq.${inviteeId}),and(user_a_id.eq.${inviteeId},user_b_id.eq.${userId})`,
      )
      .eq('status', 'accepted')
      .maybeSingle();

    if (friendError || !friendship) {
      throw new BadRequestException('Chỉ có thể gửi lời mời trực tiếp cho bạn bè đã kết bạn.');
    }

    // Kiểm tra đã là member chưa
    const { data: existingMember } = await this.supabase.client
      .from('server_members')
      .select('server_id')
      .eq('server_id', serverId)
      .eq('user_id', inviteeId)
      .maybeSingle();

    if (existingMember) {
      throw new BadRequestException('Người dùng đã là thành viên của máy chủ này.');
    }

    // Kiểm tra lời mời pending cũ
    const { data: existingInv } = await this.supabase.client
      .from('server_invitations')
      .select('id, expires_at, status')
      .eq('server_id', serverId)
      .eq('invitee_id', inviteeId)
      .eq('status', 'pending')
      .maybeSingle();

    if (existingInv) {
      const isExpired = new Date(existingInv.expires_at).getTime() <= Date.now();
      if (isExpired) {
        // Tự động chuyển pending cũ thành expired
        await this.supabase.client
          .from('server_invitations')
          .update({ status: 'expired' })
          .eq('id', existingInv.id);
      } else {
        throw new BadRequestException('Đã có lời mời đang chờ người dùng này phản hồi.');
      }
    }

    // Tạo lời mời mới
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: createdInv, error: insertError } = await this.supabase.client
      .from('server_invitations')
      .insert({
        server_id: serverId,
        inviter_id: userId,
        invitee_id: inviteeId,
        status: 'pending',
        expires_at: expiresAt,
      })
      .select('id, server_id, inviter_id, status, created_at, expires_at')
      .single();

    if (insertError || !createdInv) {
      if (insertError?.code === '23505') {
        throw new ConflictException('Đã có lời mời đang chờ người dùng này phản hồi trên máy chủ.');
      }
      this.logger.error(`Tạo direct invitation thất bại: ${insertError?.message}`);
      throw new InternalServerErrorException('Không thể gửi lời mời trực tiếp.');
    }

    // Lấy thông tin server và inviter để build DTO
    const [serverRes, inviterRes] = await Promise.all([
      this.supabase.client.from('servers').select('name, icon_url').eq('id', serverId).single(),
      this.supabase.client.from('profiles').select('username, display_name, avatar_url').eq('id', userId).single(),
    ]);

    const result: DirectServerInvitationDto = {
      id: createdInv.id,
      serverId: createdInv.server_id,
      serverName: serverRes.data?.name || 'Máy chủ',
      serverIconUrl: serverRes.data?.icon_url ?? null,
      inviterId: userId,
      inviterDisplayName: inviterRes.data?.display_name || inviterRes.data?.username || 'Người dùng',
      inviterUsername: inviterRes.data?.username || '',
      inviterAvatarUrl: inviterRes.data?.avatar_url ?? null,
      status: 'pending',
      createdAt: createdInv.created_at,
      expiresAt: createdInv.expires_at,
    };

    // Gửi realtime notification tới invitee
    this.chatGateway.emitInvitationReceived(inviteeId, result);

    return result;
  }

  /**
   * Danh sách lời mời pending của người dùng hiện tại.
   */
  async listPendingInvitations(userId: string): Promise<DirectServerInvitationDto[]> {
    const { data: invs, error } = await this.supabase.client
      .from('server_invitations')
      .select(`
        id,
        server_id,
        inviter_id,
        status,
        created_at,
        expires_at,
        servers:server_id ( name, icon_url )
      `)
      .eq('invitee_id', userId)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });

    if (error) {
      this.logger.error(`Lấy danh sách pending invitations thất bại: ${error.message}`);
      throw new InternalServerErrorException('Không thể lấy danh sách lời mời.');
    }

    if (!invs || invs.length === 0) {
      return [];
    }

    const inviterIds = [...new Set(invs.map((i: any) => i.inviter_id).filter(Boolean))];
    let profileMap = new Map<string, any>();
    if (inviterIds.length > 0) {
      const { data: profiles } = await this.supabase.client
        .from('profiles')
        .select('id, username, display_name, avatar_url')
        .in('id', inviterIds);

      profileMap = new Map((profiles || []).map((p: any) => [p.id, p]));
    }

    return invs.map((inv: any) => {
      const inviter = profileMap.get(inv.inviter_id);
      return {
        id: inv.id,
        serverId: inv.server_id,
        serverName: inv.servers?.name || 'Máy chủ',
        serverIconUrl: inv.servers?.icon_url ?? null,
        inviterId: inv.inviter_id,
        inviterDisplayName: inviter?.display_name || inviter?.username || 'Người dùng',
        inviterUsername: inviter?.username || '',
        inviterAvatarUrl: inviter?.avatar_url ?? null,
        status: 'pending',
        createdAt: inv.created_at,
        expiresAt: inv.expires_at,
      };
    });
  }

  /**
   * Chấp nhận lời mời trực tiếp qua RPC nguyên tử.
   */
  async acceptInvitation(
    userId: string,
    invitationId: string,
  ): Promise<{ success: boolean; serverId: string; alreadyMember: boolean }> {
    const { data: inv } = await this.supabase.client
      .from('server_invitations')
      .select('id, server_id, inviter_id, invitee_id')
      .eq('id', invitationId)
      .maybeSingle();

    const { data, error } = await this.supabase.client.rpc('accept_server_invitation', {
      p_invitation_id: invitationId,
      p_user_id: userId,
    });

    if (error) {
      this.logger.error(`Chấp nhận lời mời thất bại: ${error.message} (code: ${error.code})`);
      if (error.code === '42501') {
        throw new ForbiddenException(error.message);
      }
      if (error.code === 'P0002') {
        throw new NotFoundException(error.message);
      }
      if (error.code === '22023') {
        throw new BadRequestException(error.message);
      }
      throw new InternalServerErrorException('Không thể chấp nhận lời mời.');
    }

    if (data && data.success === false) {
      throw new BadRequestException(data.message || 'Không thể chấp nhận lời mời.');
    }

    if (inv) {
      this.chatGateway.emitInvitationUpdated(inv.inviter_id, userId, {
        invitationId,
        serverId: inv.server_id,
        inviteeId: userId,
        status: 'accepted',
      });

      if (data && data.success === true && !data.alreadyMember) {
        try {
          const { data: profile } = await this.supabase.client
            .from('profiles')
            .select('id, username, display_name, avatar_url, created_at')
            .eq('id', userId)
            .maybeSingle();

          const memberDto: ServerMemberDto = {
            userId,
            username: profile?.username || '',
            displayName: profile?.display_name || profile?.username || 'User',
            avatarUrl: profile?.avatar_url || null,
            nickname: null,
            role: 'MEMBER',
            joinedAt: new Date().toISOString(),
            nexusJoinedAt: profile?.created_at || null,
            joinMethod: 'Lời mời trực tiếp',
          };

          this.chatGateway.emitServerMemberJoined(inv.server_id, memberDto);
        } catch (emitErr: any) {
          this.logger.warn(`Phát tán sự kiện server:member-joined thất bại: ${emitErr?.message}`);
        }
      }
    }

    return data;
  }

  /**
   * Từ chối lời mời trực tiếp.
   */
  async declineInvitation(
    userId: string,
    invitationId: string,
  ): Promise<{ success: boolean }> {
    const { data: inv, error: findError } = await this.supabase.client
      .from('server_invitations')
      .select('id, server_id, inviter_id, invitee_id, status')
      .eq('id', invitationId)
      .maybeSingle();

    if (findError) {
      throw new InternalServerErrorException('Lỗi tra cứu lời mời.');
    }

    if (!inv) {
      throw new NotFoundException('Lời mời không tồn tại.');
    }

    if (inv.invitee_id !== userId) {
      throw new ForbiddenException('Bạn không phải là người nhận lời mời này.');
    }

    if (inv.status !== 'pending') {
      throw new BadRequestException('Lời mời không còn ở trạng thái chờ.');
    }

    const { error: updateError } = await this.supabase.client
      .from('server_invitations')
      .update({ status: 'declined' })
      .eq('id', invitationId);

    if (updateError) {
      throw new InternalServerErrorException('Không thể từ chối lời mời.');
    }

    this.chatGateway.emitInvitationUpdated(inv.inviter_id, userId, {
      invitationId,
      serverId: inv.server_id,
      inviteeId: userId,
      status: 'declined',
    });

    return { success: true };
  }

  /**
   * Thu hồi lời mời trực tiếp (bởi người gửi hoặc quản trị viên).
   */
  async revokeDirectInvitation(
    userId: string,
    serverId: string,
    invitationId: string,
  ): Promise<{ success: boolean }> {
    const { data: inv, error: findError } = await this.supabase.client
      .from('server_invitations')
      .select('id, server_id, inviter_id, invitee_id, status')
      .eq('id', invitationId)
      .eq('server_id', serverId)
      .maybeSingle();

    if (findError) {
      throw new InternalServerErrorException('Lỗi tra cứu lời mời.');
    }

    if (!inv) {
      throw new NotFoundException('Lời mời không tồn tại.');
    }

    if (inv.inviter_id !== userId) {
      await this.permissionsService.assertCanManageServer(userId, serverId);
    }

    const { error: updateError } = await this.supabase.client
      .from('server_invitations')
      .update({ status: 'revoked' })
      .eq('id', invitationId);

    if (updateError) {
      throw new InternalServerErrorException('Không thể thu hồi lời mời.');
    }

    this.chatGateway.emitInvitationUpdated(inv.inviter_id, inv.invitee_id, {
      invitationId,
      serverId,
      inviteeId: inv.invitee_id,
      status: 'revoked',
    });

    return { success: true };
  }

  /**
   * Tạo liên kết mời tham gia máy chủ (mã hóa 128-bit entropy cao).
   */
  async createInviteLink(
    userId: string,
    serverId: string,
    dto: CreateInviteLinkDto,
  ): Promise<ServerInviteLinkResponseDto> {
    await this.permissionsService.assertCanInvite(userId, serverId);

    let channelName: string | undefined;
    if (dto.channelId) {
      const { data: channel } = await this.supabase.client
        .from('channels')
        .select('name')
        .eq('id', dto.channelId)
        .eq('server_id', serverId)
        .maybeSingle();

      channelName = channel?.name;
    }

    const maxUses = dto.maxUses ?? null;
    const expiresAt = dto.expiresInSeconds
      ? new Date(Date.now() + dto.expiresInSeconds * 1000).toISOString()
      : null;

    let code = '';
    let inserted = false;
    let attempts = 0;

    // Retry tối đa 3 lần nếu code collision
    while (!inserted && attempts < 3) {
      attempts++;
      code = crypto.randomBytes(16).toString('base64url');

      const { error: insertError } = await this.supabase.client
        .from('invites')
        .insert({
          code,
          server_id: serverId,
          channel_id: dto.channelId ?? null,
          inviter_id: userId,
          max_uses: maxUses,
          uses: 0,
          expires_at: expiresAt,
        });

      if (!insertError) {
        inserted = true;
      } else if (insertError.code !== '23505') {
        this.logger.error(`Tạo invite link thất bại: ${insertError.message}`);
        throw new InternalServerErrorException('Không thể tạo liên kết mời.');
      }
    }

    if (!inserted) {
      throw new InternalServerErrorException('Không thể tạo mã mời duy nhất, vui lòng thử lại.');
    }

    const { data: server } = await this.supabase.client
      .from('servers')
      .select('name, icon_url')
      .eq('id', serverId)
      .single();

    const isProduction = process.env.NODE_ENV === 'production';
    const baseUrl = process.env.PUBLIC_WEB_URL || process.env.FRONTEND_URL;
    if (isProduction && (!baseUrl || baseUrl.trim() === '')) {
      throw new InternalServerErrorException(
        'Biến môi trường PUBLIC_WEB_URL hoặc FRONTEND_URL bắt buộc phải được cấu hình trong môi trường Production.',
      );
    }
    const appBaseUrl = baseUrl ? baseUrl.replace(/\/+$/, '') : 'http://localhost:4200';
    const inviteUrl = `${appBaseUrl}/invite/${code}`;

    return {
      code,
      invitePath: `/invite/${code}`,
      inviteUrl,
      serverId,
      serverName: server?.name || 'Máy chủ',
      serverIconUrl: server?.icon_url ?? null,
      channelId: dto.channelId ?? null,
      channelName,
      expiresAt,
      maxUses,
      uses: 0,
    };
  }

  /**
   * Thu hồi liên kết mời theo code: DELETE /api/servers/:serverId/invites/:code
   */
  async revokeInviteLink(
    userId: string,
    serverId: string,
    code: string,
  ): Promise<{ success: boolean }> {
    const trimmedCode = code?.trim();
    if (!trimmedCode) {
      throw new BadRequestException('Mã mời không hợp lệ.');
    }

    const { data: invite, error: findError } = await this.supabase.client
      .from('invites')
      .select('code, inviter_id, server_id')
      .eq('code', trimmedCode)
      .eq('server_id', serverId)
      .maybeSingle();

    if (findError) {
      throw new InternalServerErrorException('Lỗi tra cứu liên kết mời.');
    }

    if (!invite) {
      throw new NotFoundException('Liên kết mời không tồn tại.');
    }

    if (invite.inviter_id !== userId) {
      await this.permissionsService.assertCanManageServer(userId, serverId);
    }

    const { error: deleteError } = await this.supabase.client
      .from('invites')
      .delete()
      .eq('code', trimmedCode)
      .eq('server_id', serverId);

    if (deleteError) {
      throw new InternalServerErrorException('Không thể thu hồi liên kết mời.');
    }

    return { success: true };
  }

  /**
   * Xem trước thông tin công khai an toàn của lời mời: GET /api/invites/:code
   */
  async getInvitePreview(code: string): Promise<ServerInvitePreviewDto> {
    const trimmedCode = code?.trim();
    if (!trimmedCode || trimmedCode.length < 4 || trimmedCode.length > 128) {
      throw new BadRequestException('Mã mời không hợp lệ.');
    }

    const { data: invite, error } = await this.supabase.client
      .from('invites')
      .select(`
        code,
        server_id,
        channel_id,
        inviter_id,
        max_uses,
        uses,
        expires_at,
        servers:server_id ( name, icon_url ),
        channels:channel_id ( name )
      `)
      .eq('code', trimmedCode)
      .maybeSingle();

    if (error) {
      this.logger.error(`Tra cứu invite preview thất bại: ${error.message}`);
      throw new InternalServerErrorException('Lỗi tra cứu thông tin máy chủ.');
    }

    if (!invite) {
      throw new NotFoundException('Liên kết mời không tồn tại hoặc đã bị xóa.');
    }

    // Đếm số lượng thành viên hiện tại
    const { count: memberCount } = await this.supabase.client
      .from('server_members')
      .select('*', { count: 'exact', head: true })
      .eq('server_id', invite.server_id);

    let inviterData: any = null;
    if (invite.inviter_id) {
      const { data: profile } = await this.supabase.client
        .from('profiles')
        .select('username, display_name, avatar_url')
        .eq('id', invite.inviter_id)
        .maybeSingle();
      inviterData = profile;
    }

    let status: ServerInviteStatus = 'valid';
    if (invite.expires_at && new Date(invite.expires_at).getTime() <= Date.now()) {
      status = 'expired';
    } else if (invite.max_uses !== null && invite.uses >= invite.max_uses) {
      status = 'max_used';
    }

    const serverData: any = invite.servers;
    const channelData: any = invite.channels;

    return {
      code: trimmedCode,
      serverId: invite.server_id,
      serverName: serverData?.name || 'Máy chủ',
      serverIconUrl: serverData?.icon_url ?? null,
      memberCount: memberCount ?? 1,
      channelId: invite.channel_id ?? null,
      channelName: channelData?.name ?? null,
      inviterDisplayName: inviterData?.display_name || inviterData?.username || null,
      inviterAvatarUrl: inviterData?.avatar_url ?? null,
      expiresAt: invite.expires_at ?? null,
      maxUses: invite.max_uses ?? null,
      uses: invite.uses ?? 0,
      status,
      isExpired: status === 'expired',
      isMaxUsed: status === 'max_used',
    };
  }

  /**
   * Tham gia máy chủ qua link mời: POST /api/invites/:code/join
   */
  async joinByInviteCode(
    userId: string,
    code: string,
  ): Promise<{ success: boolean; serverId: string; channelId?: string; alreadyMember: boolean }> {
    const trimmedCode = code?.trim();
    if (!trimmedCode) {
      throw new BadRequestException('Mã mời không hợp lệ.');
    }

    const { data, error } = await this.supabase.client.rpc('join_server_by_invite_code', {
      p_code: trimmedCode,
      p_user_id: userId,
    });

    if (error) {
      this.logger.error(`Tham gia server qua link thất bại: ${error.message} (code: ${error.code})`);
      if (error.code === 'P0002') {
        throw new NotFoundException(error.message);
      }
      if (error.code === '22023') {
        throw new BadRequestException(error.message);
      }
      throw new InternalServerErrorException('Không thể tham gia máy chủ qua liên kết mời.');
    }

    if (data && data.success === true && !data.alreadyMember) {
      try {
        const { data: profile } = await this.supabase.client
          .from('profiles')
          .select('id, username, display_name, avatar_url, created_at')
          .eq('id', userId)
          .maybeSingle();

        const memberDto: ServerMemberDto = {
          userId,
          username: profile?.username || '',
          displayName: profile?.display_name || profile?.username || 'User',
          avatarUrl: profile?.avatar_url || null,
          nickname: null,
          role: 'MEMBER',
          joinedAt: new Date().toISOString(),
          nexusJoinedAt: profile?.created_at || null,
          joinMethod: `/${trimmedCode}`,
        };

        this.chatGateway.emitServerMemberJoined(data.serverId, memberDto);
      } catch (emitErr: any) {
        this.logger.warn(`Phát tán sự kiện server:member-joined thất bại: ${emitErr?.message}`);
      }
    }

    return data;
  }
}
