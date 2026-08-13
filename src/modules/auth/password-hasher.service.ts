import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

@Injectable()
export class PasswordHasherService {
  async hash(plain: string): Promise<string> {
    return hash(plain);
  }

  async verify(digest: string, plain: string): Promise<boolean> {
    try {
      return await verify(digest, plain);
    } catch {
      // A malformed or truncated digest must read as "does not match" rather
      // than crashing the login path.
      return false;
    }
  }
}
