import { Injectable } from '@nestjs/common';
import { Role, User } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface CreateUserInput {
  email: string;
  passwordHash: string;
}

export interface EnsureAdminInput {
  email: string;
  passwordHash: string;
}

export type EnsureAdminOutcome = 'created' | 'promoted' | 'unchanged';

export interface EnsureAdminResult {
  user: User;
  outcome: EnsureAdminOutcome;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });
  }

  async findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async create(input: CreateUserInput): Promise<User> {
    return this.prisma.user.create({
      data: {
        email: input.email.toLowerCase(),
        passwordHash: input.passwordHash,
      },
    });
  }

  /**
   * Idempotent admin bootstrap.
   *
   * Deliberately separate from `create()`: `CreateUserInput` has no `role`
   * field, which is what makes it impossible for registration to mint an
   * ADMIN. Widening that type to serve the bootstrap would weaken a tested
   * Phase 1 invariant, so the privileged write gets its own named method.
   *
   * Never writes `passwordHash` for a user that already exists — promotion
   * and password reset are different operations, and only the first ships.
   */
  async ensureAdmin(input: EnsureAdminInput): Promise<EnsureAdminResult> {
    const email = input.email.toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });

    if (!existing) {
      const user = await this.prisma.user.create({
        data: { email, passwordHash: input.passwordHash, role: Role.ADMIN },
      });

      return { user, outcome: 'created' };
    }

    if (existing.role === Role.ADMIN) {
      return { user: existing, outcome: 'unchanged' };
    }

    const user = await this.prisma.user.update({
      where: { id: existing.id },
      data: { role: Role.ADMIN },
    });

    return { user, outcome: 'promoted' };
  }
}
