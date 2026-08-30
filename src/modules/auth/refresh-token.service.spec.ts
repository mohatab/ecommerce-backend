import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { RefreshTokenService } from './refresh-token.service';
import { TokenService } from './token.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * The argument list `RefreshTokenService` passes to `prisma.refreshToken.create`.
 * Typing the mock rather than casting its recorded calls is what keeps
 * `mock.calls[0][0]` off `any` — the assertions below read the created row
 * directly, so an untyped mock would make every one of them unchecked.
 */
type CreateCall = [{ data: Record<string, unknown> }];

describe('RefreshTokenService', () => {
  let service: RefreshTokenService;
  let prisma: {
    refreshToken: {
      create: jest.Mock<Promise<unknown>, CreateCall>;
      findUnique: jest.Mock;
      updateMany: jest.Mock<Promise<{ count: number }>, [unknown]>;
    };
  };
  let tokens: {
    generateRefreshToken: jest.Mock;
    hashToken: jest.Mock;
    refreshTokenExpiryFrom: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      refreshToken: {
        create: jest.fn<Promise<unknown>, CreateCall>().mockResolvedValue({}),
        findUnique: jest.fn(),
        // Default is a *winning* compare-and-swap (one row matched
        // `revokedAt: null`). Tests that need the losing side override it.
        updateMany: jest
          .fn<Promise<{ count: number }>, [unknown]>()
          .mockResolvedValue({ count: 1 }),
      },
    };
    tokens = {
      generateRefreshToken: jest.fn().mockReturnValue('plain-token'),
      hashToken: jest.fn((t: string) => `hash(${t})`),
      refreshTokenExpiryFrom: jest.fn().mockReturnValue(new Date('2099-01-01')),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RefreshTokenService,
        { provide: PrismaService, useValue: prisma },
        { provide: TokenService, useValue: tokens },
      ],
    }).compile();

    service = module.get<RefreshTokenService>(RefreshTokenService);
  });

  it('stores only the hash, and returns the plaintext', async () => {
    const token = await service.issue('user-1');

    expect(token).toBe('plain-token');
    const createArg = prisma.refreshToken.create.mock.calls[0][0];
    expect(createArg.data.tokenHash).toBe('hash(plain-token)');
    expect(JSON.stringify(createArg.data)).not.toContain('plain-token"');
  });

  it('rejects an unknown token', async () => {
    prisma.refreshToken.findUnique.mockResolvedValueOnce(null);

    await expect(service.rotate('nope')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('revokes the whole family when a consumed token is replayed', async () => {
    prisma.refreshToken.findUnique.mockResolvedValueOnce({
      id: 'rt-1',
      userId: 'user-1',
      familyId: 'fam-1',
      revokedAt: new Date('2026-01-01'),
      expiresAt: new Date('2099-01-01'),
    });

    await expect(service.rotate('replayed')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { familyId: 'fam-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) as Date },
    });
  });

  it('rejects an expired token without revoking the family', async () => {
    prisma.refreshToken.findUnique.mockResolvedValueOnce({
      id: 'rt-1',
      userId: 'user-1',
      familyId: 'fam-1',
      revokedAt: null,
      expiresAt: new Date('2000-01-01'),
    });

    await expect(service.rotate('stale')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('rotates a valid token, keeping the family and revoking the predecessor', async () => {
    prisma.refreshToken.findUnique.mockResolvedValueOnce({
      id: 'rt-1',
      userId: 'user-1',
      familyId: 'fam-1',
      revokedAt: null,
      expiresAt: new Date('2099-01-01'),
    });

    const result = await service.rotate('valid');

    expect(result).toEqual({ userId: 'user-1', token: 'plain-token' });
    // The consume step must carry `revokedAt: null` in its WHERE clause.
    // A plain update({ where: { id } }) would satisfy "the predecessor was
    // revoked" just as well while silently reopening the double-rotation
    // race, so the predicate itself is what this pins.
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { id: 'rt-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) as Date },
    });
    const createArg = prisma.refreshToken.create.mock.calls[0][0];
    expect(createArg.data.familyId).toBe('fam-1');
  });

  it('treats a lost compare-and-swap race as reuse: no successor, family burned', async () => {
    prisma.refreshToken.findUnique.mockResolvedValueOnce({
      id: 'rt-1',
      userId: 'user-1',
      familyId: 'fam-1',
      revokedAt: null,
      expiresAt: new Date('2099-01-01'),
    });
    // Zero rows matched `revokedAt: null` — a concurrent request consumed
    // this exact token between our read and our write. This is the state the
    // old read-check-write pattern could not observe at all: it would have
    // issued a second successor and never noticed.
    prisma.refreshToken.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.rotate('raced')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    // No successor was minted for the loser...
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    // ...and the lineage was burned, exactly as a replay would.
    expect(prisma.refreshToken.updateMany).toHaveBeenLastCalledWith({
      where: { familyId: 'fam-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) as Date },
    });
  });

  it('gives a lost race the same message as every other rejection', async () => {
    prisma.refreshToken.findUnique.mockResolvedValueOnce({
      id: 'rt-1',
      userId: 'user-1',
      familyId: 'fam-1',
      revokedAt: null,
      expiresAt: new Date('2099-01-01'),
    });
    prisma.refreshToken.updateMany.mockResolvedValueOnce({ count: 0 });

    const raced = await service.rotate('raced').catch((e: Error) => e);

    prisma.refreshToken.findUnique.mockResolvedValueOnce(null);
    const unknown = await service.rotate('nope').catch((e: Error) => e);

    expect(raced.message).toBe(unknown.message);
  });
});
