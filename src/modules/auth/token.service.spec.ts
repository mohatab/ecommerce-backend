import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { Role, User } from '@prisma/client';
import { TokenService } from './token.service';

const SECRET = 'x'.repeat(32);

const user: User = {
  id: 'user-1',
  email: 'a@example.test',
  passwordHash: 'digest',
  role: Role.CUSTOMER,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('TokenService', () => {
  let service: TokenService;

  beforeEach(async () => {
    const config = {
      get: (key: string): string =>
        key === 'jwt.accessTtl' ? '15m' : key === 'jwt.refreshTtl' ? '7d' : '',
    };

    const module: TestingModule = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: SECRET })],
      providers: [TokenService, { provide: ConfigService, useValue: config }],
    }).compile();

    service = module.get<TokenService>(TokenService);
  });

  it('signs an access token carrying the user id and role', async () => {
    const token = await service.signAccessToken(user);
    const payload = await service.verifyAccessToken(token);

    expect(payload.sub).toBe('user-1');
    expect(payload.role).toBe(Role.CUSTOMER);
  });

  it('rejects a malformed token', async () => {
    // toBeInstanceOf(Error), not toBeDefined() — the latter would pass even if
    // the underlying library rejected with a bare string. verifyAccessToken
    // does not catch or rewrap this; JwtAuthGuard (Task 10) already collapses
    // every failure shape to a generic 401 (spec §15.3).
    await expect(
      service.verifyAccessToken('not.a.token'),
    ).rejects.toBeInstanceOf(Error);
  });

  it('generates unique high-entropy refresh tokens', () => {
    const a = service.generateRefreshToken();
    const b = service.generateRefreshToken();

    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
  });

  it('hashes tokens deterministically with sha256', () => {
    const token = 'a-refresh-token';

    expect(service.hashToken(token)).toBe(service.hashToken(token));
    expect(service.hashToken(token)).toHaveLength(64);
    expect(service.hashToken(token)).not.toContain(token);
  });

  it('computes refresh expiry from the configured lifetime', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');

    const expiry = service.refreshTokenExpiryFrom(now);

    expect(expiry.toISOString()).toBe('2026-01-08T00:00:00.000Z');
  });
});
