import {
  Injectable,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { User } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { UsersService } from '../users/users.service';
import { PasswordHasherService } from './password-hasher.service';
import { RefreshTokenService } from './refresh-token.service';
import { TokenService } from './token.service';

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: User;
}

const INVALID_CREDENTIALS = 'Invalid email or password';
const INVALID_REFRESH_TOKEN = 'Invalid refresh token';
const DUMMY_PASSWORD_BYTES = 32;

@Injectable()
export class AuthService implements OnModuleInit {
  /**
   * An argon2id digest of a random value that is discarded the moment it is
   * hashed. Verified against when the email is unknown, so a missing user
   * costs the same time as a wrong password.
   *
   * Derived at boot through PasswordHasherService rather than hardcoded, so it
   * always carries the same argon2 parameters as real user digests — argon2
   * reads its cost from the digest it is verifying, so a constant generated
   * against different parameters would silently make this path cheaper than
   * the wrong-password path and reopen the timing oracle.
   *
   * Definite assignment is safe: Nest awaits onModuleInit before the
   * application accepts requests.
   */
  private dummyDigest!: string;

  constructor(
    private readonly usersService: UsersService,
    private readonly passwordHasher: PasswordHasherService,
    private readonly tokenService: TokenService,
    private readonly refreshTokenService: RefreshTokenService,
  ) {}

  async onModuleInit(): Promise<void> {
    // The plaintext is never stored, returned, or logged — it exists only for
    // the duration of this call, and nothing can authenticate against it.
    this.dummyDigest = await this.passwordHasher.hash(
      randomBytes(DUMMY_PASSWORD_BYTES).toString('hex'),
    );
  }

  async register(email: string, password: string): Promise<AuthResult> {
    const passwordHash = await this.passwordHasher.hash(password);
    // A duplicate email raises P2002, which HttpExceptionFilter maps to 409.
    // No `role` is passed, and CreateUserInput has no field for one, so
    // registration can only ever produce the schema default of CUSTOMER.
    const user = await this.usersService.create({ email, passwordHash });

    return this.issueFor(user);
  }

  async login(email: string, password: string): Promise<AuthResult> {
    const user = await this.usersService.findByEmail(email);

    // This must stay ABOVE the user-existence branch. Verifying
    // unconditionally is what makes an unknown email cost the same argon2 work
    // as a wrong password. Moving it below `if (!user)` — or short-circuiting
    // on a missing user — turns login into an email-enumeration oracle, and no
    // functional test would notice because the responses stay identical.
    const matches = await this.passwordHasher.verify(
      user?.passwordHash ?? this.dummyDigest,
      password,
    );

    if (!user || !matches) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    return this.issueFor(user);
  }

  async refresh(presented: string): Promise<AuthResult> {
    const { userId, token } = await this.refreshTokenService.rotate(presented);
    const user = await this.usersService.findById(userId);

    if (!user) {
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN);
    }

    return {
      accessToken: await this.tokenService.signAccessToken(user),
      refreshToken: token,
      user,
    };
  }

  async logout(userId: string): Promise<void> {
    await this.refreshTokenService.revokeAllForUser(userId);
  }

  private async issueFor(user: User): Promise<AuthResult> {
    return {
      accessToken: await this.tokenService.signAccessToken(user),
      refreshToken: await this.refreshTokenService.issue(user.id),
      user,
    };
  }
}
