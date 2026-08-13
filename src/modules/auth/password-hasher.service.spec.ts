import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PasswordHasherService } from './password-hasher.service';

describe('PasswordHasherService', () => {
  let hasher: PasswordHasherService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PasswordHasherService],
    }).compile();

    hasher = module.get<PasswordHasherService>(PasswordHasherService);
  });

  it('produces an argon2id digest that does not contain the password', async () => {
    const digest = await hasher.hash('correct horse battery staple');

    expect(digest).toContain('$argon2id$');
    expect(digest).not.toContain('correct horse battery staple');
  });

  it('verifies a correct password', async () => {
    const digest = await hasher.hash('s3cret-password');

    await expect(hasher.verify(digest, 's3cret-password')).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const digest = await hasher.hash('s3cret-password');

    await expect(hasher.verify(digest, 'wrong-password')).resolves.toBe(false);
  });

  it('returns false rather than throwing on a malformed digest', async () => {
    await expect(hasher.verify('not-a-digest', 'anything')).resolves.toBe(
      false,
    );
  });

  it('logs a warning on a malformed digest without leaking the plaintext password', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    const plain = 'anything-super-secret';
    await hasher.verify('not-a-digest', plain);

    expect(warnSpy).toHaveBeenCalled();

    const loggedText = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(loggedText).not.toContain(plain);

    warnSpy.mockRestore();
  });

  it('produces different digests for the same password, both of which verify', async () => {
    const digestA = await hasher.hash('s3cret-password');
    const digestB = await hasher.hash('s3cret-password');

    expect(digestA).not.toEqual(digestB);
    await expect(hasher.verify(digestA, 's3cret-password')).resolves.toBe(true);
    await expect(hasher.verify(digestB, 's3cret-password')).resolves.toBe(true);
  });
});
