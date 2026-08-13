import { Injectable, Logger } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

@Injectable()
export class PasswordHasherService {
  private readonly logger = new Logger(PasswordHasherService.name);

  async hash(plain: string): Promise<string> {
    return hash(plain);
  }

  async verify(digest: string, plain: string): Promise<boolean> {
    try {
      return await verify(digest, plain);
    } catch (error) {
      // A malformed or truncated digest must read as "does not match" rather
      // than crashing the login path, so we still fail closed here. But
      // swallowing the error entirely would hide a systemic failure (e.g. a
      // broken native binding, or an unreplaced DUMMY_DIGEST placeholder)
      // behind what looks like an ordinary wrong-password result — so it is
      // logged. Only the error itself is logged, never the digest or plain.
      this.logger.warn(error);
      return false;
    }
  }
}
