import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { Role, User } from '@prisma/client';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { PasswordHasherService } from './password-hasher.service';
import { TokenService } from './token.service';
import { RefreshTokenService } from './refresh-token.service';

const user: User = {
  id: 'user-1',
  email: 'a@example.test',
  passwordHash: 'digest',
  role: Role.CUSTOMER,
  createdAt: new Date(),
  updatedAt: new Date(),
};

/**
 * The digest `onModuleInit` derives, distinct from every other mocked hash so
 * the timing-defence test can prove login verified against *that* value rather
 * than against some incidental string.
 */
const BOOT_DIGEST = 'boot-derived-dummy-digest';

/** An argon2id encoded digest: `$argon2id$v=19$m=<n>,t=<n>,p=<n>$salt$hash`. */
const ARGON2ID_ENCODING = /^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$/;

/** The `$argon2id$v=19$m=..,t=..,p=..` prefix, i.e. everything before the salt. */
function parameterPrefix(digest: string): string {
  return digest.split('$').slice(0, 4).join('$');
}

describe('AuthService', () => {
  let service: AuthService;
  let users: { findByEmail: jest.Mock; findById: jest.Mock; create: jest.Mock };
  let hasher: {
    hash: jest.Mock<Promise<string>, [string]>;
    verify: jest.Mock<Promise<boolean>, [string, string]>;
  };
  let tokens: { signAccessToken: jest.Mock };
  let refreshTokens: {
    issue: jest.Mock;
    rotate: jest.Mock;
    revokeAllForUser: jest.Mock;
  };

  beforeEach(async () => {
    users = {
      findByEmail: jest.fn(),
      findById: jest.fn(),
      create: jest.fn().mockResolvedValue(user),
    };
    hasher = {
      hash: jest.fn<Promise<string>, [string]>().mockResolvedValue('digest'),
      verify: jest
        .fn<Promise<boolean>, [string, string]>()
        .mockResolvedValue(true),
    };
    tokens = { signAccessToken: jest.fn().mockResolvedValue('access-token') };
    refreshTokens = {
      issue: jest.fn().mockResolvedValue('refresh-token'),
      rotate: jest.fn(),
      revokeAllForUser: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: users },
        { provide: PasswordHasherService, useValue: hasher },
        { provide: TokenService, useValue: tokens },
        { provide: RefreshTokenService, useValue: refreshTokens },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);

    // The boot hash resolves to a distinctive value; every later hash() call
    // falls through to the plain 'digest' default.
    hasher.hash.mockResolvedValueOnce(BOOT_DIGEST);
    await service.onModuleInit();
  });

  it('hashes the password on register and never stores plaintext', async () => {
    const result = await service.register('a@example.test', 'Test1234!');

    expect(hasher.hash).toHaveBeenCalledWith('Test1234!');
    expect(users.create).toHaveBeenCalledWith({
      email: 'a@example.test',
      passwordHash: 'digest',
    });
    expect(result.accessToken).toBe('access-token');
    expect(result.refreshToken).toBe('refresh-token');
  });

  it('never lets register set a role, so registration cannot create an ADMIN', async () => {
    await service.register('a@example.test', 'Test1234!');

    // toHaveBeenCalledWith is an exact match: an added `role` key fails here.
    expect(users.create).toHaveBeenCalledWith({
      email: 'a@example.test',
      passwordHash: 'digest',
    });
  });

  it('logs in with correct credentials', async () => {
    users.findByEmail.mockResolvedValueOnce(user);

    const result = await service.login('a@example.test', 'Test1234!');

    expect(result.user).toBe(user);
  });

  it('rejects an unknown email and a wrong password identically', async () => {
    users.findByEmail.mockResolvedValueOnce(null);
    const unknown = await service
      .login('nobody@example.test', 'Test1234!')
      .catch((error: UnauthorizedException) => error);

    users.findByEmail.mockResolvedValueOnce(user);
    hasher.verify.mockResolvedValueOnce(false);
    const wrongPassword = await service
      .login('a@example.test', 'wrong')
      .catch((error: UnauthorizedException) => error);

    expect(unknown).toBeInstanceOf(UnauthorizedException);
    expect(wrongPassword).toBeInstanceOf(UnauthorizedException);
    expect((unknown as UnauthorizedException).message).toBe(
      (wrongPassword as UnauthorizedException).message,
    );
  });

  it('verifies against the boot-derived dummy digest when the user does not exist', async () => {
    users.findByEmail.mockResolvedValueOnce(null);

    await service.login('nobody@example.test', 'Test1234!').catch(() => null);

    // Asserting the exact digest, not merely that verify() was called: a
    // hardcoded placeholder would still satisfy "was called" while doing no
    // argon2 work at all, which is the failure mode this defence exists to
    // prevent. Without equivalent work here, "user not found" returns
    // measurably faster than "wrong password" and login becomes an
    // email-enumeration oracle.
    expect(hasher.verify).toHaveBeenCalledWith(BOOT_DIGEST, 'Test1234!');
  });

  it('derives the dummy digest from 32 random bytes at initialisation', () => {
    expect(hasher.hash).toHaveBeenCalledWith(
      expect.stringMatching(/^[0-9a-f]{64}$/),
    );
  });

  it('derives a fresh dummy password on every initialisation', async () => {
    await service.onModuleInit();

    const first = hasher.hash.mock.calls[0][0];
    const second = hasher.hash.mock.calls[1][0];

    expect(first).not.toBe(second);
  });

  it('issues a new pair on refresh', async () => {
    refreshTokens.rotate.mockResolvedValueOnce({
      userId: 'user-1',
      token: 'next-refresh',
    });
    users.findById.mockResolvedValueOnce(user);

    const result = await service.refresh('presented');

    expect(result.refreshToken).toBe('next-refresh');
    expect(result.accessToken).toBe('access-token');
  });

  it('rejects a refresh whose token rotates to a user that no longer exists', async () => {
    refreshTokens.rotate.mockResolvedValueOnce({
      userId: 'ghost',
      token: 'next-refresh',
    });
    users.findById.mockResolvedValueOnce(null);

    // Near-unreachable in production because onDelete: Cascade removes a
    // user's tokens with the user, so rotate() would reject first. That is
    // exactly why it needs a unit test: e2e cannot construct the state.
    await expect(service.refresh('presented')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('revokes every token for the user on logout', async () => {
    await service.logout('user-1');

    expect(refreshTokens.revokeAllForUser).toHaveBeenCalledWith('user-1');
  });
});

describe('AuthService dummy digest, against the real hasher', () => {
  let service: AuthService;
  let hasher: PasswordHasherService;
  let verifySpy: jest.SpyInstance<Promise<boolean>, [string, string]>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        PasswordHasherService,
        { provide: UsersService, useValue: { findByEmail: jest.fn() } },
        { provide: TokenService, useValue: {} },
        { provide: RefreshTokenService, useValue: {} },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    hasher = module.get<PasswordHasherService>(PasswordHasherService);
    verifySpy = jest.spyOn(hasher, 'verify');

    await service.onModuleInit();
  });

  /**
   * Reads the digest login actually verified against, rather than reaching
   * into a private field — this is the value that has to do real argon2 work.
   */
  async function digestUsedForUnknownEmail(): Promise<string> {
    await service.login('nobody@example.test', 'irrelevant').catch(() => null);

    return verifySpy.mock.calls[0][0];
  }

  it('verifies unknown emails against a well-formed argon2id digest', async () => {
    expect(await digestUsedForUnknownEmail()).toMatch(ARGON2ID_ENCODING);
  });

  it('uses the same argon2 parameters as a real user password digest', async () => {
    const dummy = await digestUsedForUnknownEmail();
    const real = await hasher.hash('a-real-user-password');

    // Argon2 reads its cost parameters from the digest being verified, not
    // from any global setting. If the dummy carried different m/t/p, the
    // unknown-email path would cost measurably less than the wrong-password
    // path and reopen the timing oracle — silently, with every other test
    // still green.
    expect(parameterPrefix(dummy)).toBe(parameterPrefix(real));
  });
});
