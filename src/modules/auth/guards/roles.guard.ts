import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { Request } from 'express';
import { ROLES_KEY } from '../../../common/decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Authorization is opt-in, the inverse of JwtAuthGuard's default-deny.
    // Authentication has a safe universal default (require it); authorization
    // does not — a fail-closed default would have to invent a required role
    // for every route, including the public catalog. The residual risk (a
    // write route that forgets @Roles()) is handled structurally by putting
    // every admin route on a controller with a class-level decorator, and by
    // a per-route 403 assertion in the e2e suite.
    if (required === undefined || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user;

    // No principal on a role-restricted route means the route also carries
    // @Public(), which is a misconfiguration. Deny — and deny with 403, not
    // 401: reporting an authentication failure here would misattribute the
    // fault and hand the caller a misleading retry.
    if (!user) {
      throw new ForbiddenException('Forbidden');
    }

    if (!required.includes(user.role)) {
      throw new ForbiddenException('Forbidden');
    }

    return true;
  }
}
