import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@supabase/supabase-js';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import type {
  FriendRequestsResponseDto,
  FriendRequestSummaryDto,
  FriendSummaryDto,
} from './dto/friend-response.dto';
import { SendRequestDto } from './dto/send-request.dto';
import { FriendsService } from './friends.service';

@Controller('friends')
@UseGuards(SupabaseAuthGuard)
export class FriendsController {
  constructor(private readonly friends: FriendsService) {}

  @Post('requests')
  @HttpCode(HttpStatus.CREATED)
  sendRequest(
    @CurrentUser() user: User,
    @Body() dto: SendRequestDto,
  ): Promise<FriendRequestSummaryDto> {
    return this.friends.sendRequest(user.id, dto.username);
  }

  @Get()
  listFriends(@CurrentUser() user: User): Promise<FriendSummaryDto[]> {
    return this.friends.listFriends(user.id);
  }

  @Get('requests')
  listRequests(
    @CurrentUser() user: User,
  ): Promise<FriendRequestsResponseDto> {
    return this.friends.listRequests(user.id);
  }

  @Patch('requests/:userId/accept')
  acceptRequest(
    @CurrentUser() user: User,
    @Param('userId', new ParseUUIDPipe({ version: '4' })) requesterId: string,
  ): Promise<FriendSummaryDto> {
    return this.friends.acceptRequest(user.id, requesterId);
  }

  @Delete('requests/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteRequest(
    @CurrentUser() user: User,
    @Param('userId', new ParseUUIDPipe({ version: '4' })) otherUserId: string,
  ): Promise<void> {
    await this.friends.deleteRequest(user.id, otherUserId);
  }

  @Delete(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeFriend(
    @CurrentUser() user: User,
    @Param('userId', new ParseUUIDPipe({ version: '4' })) friendId: string,
  ): Promise<void> {
    await this.friends.removeFriend(user.id, friendId);
  }
}
