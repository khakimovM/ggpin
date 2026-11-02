import { Body, Controller, Get, Patch } from '@nestjs/common';
import type { Me } from '@repo/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { UpdateMeDto } from './dto/update-me.dto';
import { UsersService } from './users.service';

// The user id comes from the session only: there is no id parameter anywhere on /me.
@Controller('me')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  getMe(@CurrentUser('id') userId: string): Promise<Me> {
    return this.users.getMe(userId);
  }

  @Patch()
  updateMe(@CurrentUser('id') userId: string, @Body() body: UpdateMeDto): Promise<Me> {
    return this.users.updateLocale(userId, body.locale);
  }
}
