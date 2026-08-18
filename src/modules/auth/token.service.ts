import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { User } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { AppConfig } from '../../config/configuration';
import { AuthenticatedUser } from './types/authenticated-user';

const REFRESH_TOKEN_BYTES = 32;

@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<AppConfig, true>,
  ) {}

  async signAccessToken(user: User): Promise<string> {
    const payload: AuthenticatedUser = {
      sub: user.id,
      role: user.role,
    };

    return this.jwtService.signAsync(payload, {
      expiresIn: this.configService.get('jwt.accessTtl', { infer: true }),
    });
  }

  async verifyAccessToken(token: string): Promise<AuthenticatedUser> {
    return this.jwtService.verifyAsync<AuthenticatedUser>(token);
  }

  /**
   * 256 bits of CSPRNG output. High entropy is why these are hashed with
   * SHA-256 rather than argon2 — there is no dictionary to defend against,
   * and a salted digest could not be looked up by hash at all.
   */
  generateRefreshToken(): string {
    return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  }

  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  refreshTokenExpiryFrom(now: Date): Date {
    const ttl = this.configService.get('jwt.refreshTtl', { infer: true });

    return new Date(now.getTime() + parseDurationMs(ttl));
  }
}

/** Supports the `30s` / `15m` / `24h` / `7d` forms used in .env.example. */
function parseDurationMs(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value);

  if (!match) {
    throw new Error(`Unsupported duration format: ${value}`);
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return amount * multipliers[unit];
}
