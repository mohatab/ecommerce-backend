import { Role } from '@prisma/client';
import { bootstrapAdmin } from './bootstrap-admin';

describe('bootstrapAdmin', () => {
  let usersService: { ensureAdmin: jest.Mock };
  let passwordHasher: { hash: jest.Mock };

  beforeEach(() => {
    usersService = { ensureAdmin: jest.fn() };
    passwordHasher = { hash: jest.fn().mockResolvedValue('hashed-digest') };
  });

  const deps = (email?: string, password?: string) => ({
    email,
    password,
    usersService: usersService as never,
    passwordHasher: passwordHasher as never,
  });

  it('hashes the password with the real hasher and creates the admin', async () => {
    usersService.ensureAdmin.mockResolvedValueOnce({
      user: { id: 'u1', role: Role.ADMIN },
      outcome: 'created',
    });

    const outcome = await bootstrapAdmin(
      deps('boss@example.test', 'Test1234!'),
    );

    expect(passwordHasher.hash).toHaveBeenCalledWith('Test1234!');
    expect(usersService.ensureAdmin).toHaveBeenCalledWith({
      email: 'boss@example.test',
      passwordHash: 'hashed-digest',
    });
    expect(outcome).toBe('created');
  });

  it('reports promotion of an existing user', async () => {
    usersService.ensureAdmin.mockResolvedValueOnce({
      user: { id: 'u1', role: Role.ADMIN },
      outcome: 'promoted',
    });

    await expect(
      bootstrapAdmin(deps('boss@example.test', 'Test1234!')),
    ).resolves.toBe('promoted');
  });

  it('is a no-op on a second run', async () => {
    usersService.ensureAdmin.mockResolvedValueOnce({
      user: { id: 'u1', role: Role.ADMIN },
      outcome: 'unchanged',
    });

    await expect(
      bootstrapAdmin(deps('boss@example.test', 'Test1234!')),
    ).resolves.toBe('unchanged');
  });

  it('aborts when ADMIN_EMAIL is missing', async () => {
    await expect(bootstrapAdmin(deps(undefined, 'Test1234!'))).rejects.toThrow(
      /ADMIN_EMAIL/,
    );
    expect(usersService.ensureAdmin).not.toHaveBeenCalled();
  });

  it('aborts when ADMIN_PASSWORD is missing', async () => {
    await expect(
      bootstrapAdmin(deps('boss@example.test', undefined)),
    ).rejects.toThrow(/ADMIN_PASSWORD/);
    expect(usersService.ensureAdmin).not.toHaveBeenCalled();
  });
});
