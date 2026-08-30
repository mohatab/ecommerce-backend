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

    // Compare-and-swap, not a plain update. The `revokedAt: null` predicate
    // travels *with* the write, so consuming the token is a single atomic
    // statement rather than the read-check-write above it. Without this,
    // two requests presenting the same token concurrently both read
    // `revokedAt: null`, both pass the check above, and both rotate — two
    // live siblings in one family, and the reuse detection never fires. The
    // token would have been consumed twice without ever being *observed* as
    // consumed.
    //
    // Postgres serialises the two updateMany statements on the row itself,
    // so exactly one can match `revokedAt: null`. No SELECT FOR UPDATE, no
    // advisory lock, and no transaction held across the JWT signing below.
    const consumed = await this.prisma.refreshToken.updateMany({
      where: { id: existing.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    // Lost the race: someone else consumed this exact token between our read
    // and our write. On the wire that is indistinguishable from a replayed
    // steal — the same judgement the revokedAt branch above makes — so it
    // gets the same answer.
    if (consumed.count === 0) {
      await this.revokeFamily(existing.familyId);
      throw new UnauthorizedException(REJECTION);
    }

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
