import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { TokenService } from '../token.service';

const BEARER_PREFIX = 'Bearer ';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokenService: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (isPublic === true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;

    // Deliberately case-sensitive: RFC 7235 allows any case for the auth
    // scheme, but every real client sends "Bearer", and the simpler check
    // is preferred over case-insensitive parsing for a scheme no one varies.
    if (!header?.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException('Unauthorized');
    }

    try {
      request.user = await this.tokenService.verifyAccessToken(
        header.slice(BEARER_PREFIX.length),
      );
    } catch {
      // Expired, tampered, or wrong-secret tokens are all just "unauthorized".
      throw new UnauthorizedException('Unauthorized');
    }

    return true;
  }
}
