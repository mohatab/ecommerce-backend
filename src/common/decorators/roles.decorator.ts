import { CustomDecorator, SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';

export const ROLES_KEY = 'roles';

/**
 * Marks a route (or a whole controller) as requiring one of the listed roles.
 *
 * Metadata only, with no injected dependency, which is why it lives in
 * `common/` beside `@Public()` while the guard that reads it lives in
 * `modules/auth/` — the guard consumes `AuthenticatedUser`, and pointing
 * `common/` at a feature module would invert the layering.
 */
export const Roles = (...roles: Role[]): CustomDecorator =>
  SetMetadata(ROLES_KEY, roles);
