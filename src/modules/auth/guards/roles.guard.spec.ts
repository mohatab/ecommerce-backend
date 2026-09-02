import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { RolesGuard } from './roles.guard';

interface MockRequest {
  user?: { sub: string; role: Role };
}

function contextFor(request: MockRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => jest.fn(),
    getClass: () => jest.fn(),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let guard: RolesGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    guard = new RolesGuard(reflector as unknown as Reflector);
  });

  it('allows a route with no @Roles() metadata', () => {
    reflector.getAllAndOverride.mockReturnValueOnce(undefined);

    expect(guard.canActivate(contextFor({}))).toBe(true);
  });

  it('allows a route whose @Roles() list is empty', () => {
    reflector.getAllAndOverride.mockReturnValueOnce([]);

    expect(guard.canActivate(contextFor({}))).toBe(true);
  });

  it('allows a caller holding the required role', () => {
    reflector.getAllAndOverride.mockReturnValueOnce([Role.ADMIN]);

    const context = contextFor({ user: { sub: 'u1', role: Role.ADMIN } });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('denies a caller holding a different role', () => {
    reflector.getAllAndOverride.mockReturnValueOnce([Role.ADMIN]);

    const context = contextFor({ user: { sub: 'u1', role: Role.CUSTOMER } });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('denies when metadata is present but no user was attached', () => {
    // Only reachable if a route carries both @Public() and @Roles(), which is
    // a configuration error. It must deny rather than crash, and it must not
    // report 401 — authentication is JwtAuthGuard's answer, not this guard's.
    reflector.getAllAndOverride.mockReturnValueOnce([Role.ADMIN]);

    expect(() => guard.canActivate(contextFor({}))).toThrow(ForbiddenException);
  });
});
