import { Role } from '@prisma/client';

export interface AuthenticatedUser {
  sub: string;
  role: Role;
}

declare module 'express' {
  interface Request {
    user?: AuthenticatedUser;
  }
}
