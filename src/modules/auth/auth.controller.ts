import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { AuthResponseDto } from './dto/auth-response.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RegisterDto } from './dto/register.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { UsersService } from '../users/users.service';
import { Public } from '../../common/decorators/public.decorator';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
  ) {}

  @Public()
  // Overrides the default throttler for this route only. The key must be
  // `default` — that is the name ThrottlerModule.forRoot assigns when no
  // explicit name is given.
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post('register')
  @ApiOperation({ summary: 'Register a new account' })
  @ApiResponse({ status: 201, description: 'Account created' })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 409, description: 'Email already registered' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async register(@Body() dto: RegisterDto): Promise<AuthResponseDto> {
    return AuthResponseDto.from(
      await this.authService.register(dto.email, dto.password),
    );
  }

  @Public()
  // Overrides the default throttler for this route only. The key must be
  // `default` — that is the name ThrottlerModule.forRoot assigns when no
  // explicit name is given.
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange credentials for tokens' })
  @ApiResponse({ status: 200, description: 'Authenticated' })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 401, description: 'Invalid email or password' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async login(@Body() dto: LoginDto): Promise<AuthResponseDto> {
    return AuthResponseDto.from(
      await this.authService.login(dto.email, dto.password),
    );
  }

  @Public()
  // Overrides the default throttler for this route only. The key must be
  // `default` — that is the name ThrottlerModule.forRoot assigns when no
  // explicit name is given.
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate a refresh token' })
  @ApiResponse({ status: 200, description: 'New token pair issued' })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 401, description: 'Invalid refresh token' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async refresh(@Body() dto: RefreshDto): Promise<AuthResponseDto> {
    return AuthResponseDto.from(
      await this.authService.refresh(dto.refreshToken),
    );
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke every refresh token for the caller' })
  @ApiResponse({ status: 204, description: 'Logged out' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  // request.user is guaranteed by the global JwtAuthGuard; these routes are
  // not marked @Public(), so an unauthenticated request never reaches here.
  async logout(@Req() request: Request): Promise<void> {
    await this.authService.logout(request.user!.sub);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Return the authenticated principal' })
  @ApiResponse({ status: 200, description: 'The current user' })
  @ApiResponse({
    status: 401,
    description: 'Missing, invalid, or orphaned token',
  })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async me(@Req() request: Request): Promise<UserResponseDto> {
    const user = await this.usersService.findById(request.user!.sub);

    // A structurally valid token whose user row is gone (deleted account,
    // wiped database) must read as unauthorized. Asserting non-null here
    // would throw a TypeError and surface as a 500.
    if (!user) {
      throw new UnauthorizedException('Unauthorized');
    }

    return UserResponseDto.from(user);
  }
}
