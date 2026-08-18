import { Injectable, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from './token.service';

/**
 * Every rejection uses this identical message. Distinguishing "unknown token"
 * from "expired" from "replayed" would tell an attacker which of those they
 * are holding.
 */
const REJECTION = 'Invalid refresh token';

@Injectable()
export class RefreshTokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
  ) {}

  async issue(userId: string, familyId?: string): Promise<string> {
    const token = this.tokenService.generateRefreshToken();

    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.tokenService.hashToken(token),
        familyId: familyId ?? randomUUID(),
        expiresAt: this.tokenService.refreshTokenExpiryFrom(new Date()),
      },
    });

    return token;
  }

  async rotate(presented: string): Promise<{ userId: string; token: string }> {
    const tokenHash = this.tokenService.hashToken(presented);
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });

    if (!existing) {
      throw new UnauthorizedException(REJECTION);
    }

    // Already consumed: either a legitimate race or a replayed steal. We
    // cannot tell them apart, so we assume compromise and burn the lineage.
    if (existing.revokedAt) {
      await this.revokeFamily(existing.familyId);
      throw new UnauthorizedException(REJECTION);
    }

    if (existing.expiresAt <= new Date()) {
      throw new UnauthorizedException(REJECTION);
    }

    await this.prisma.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    });

    const token = await this.issue(existing.userId, existing.familyId);

    return { userId: existing.userId, token };
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
