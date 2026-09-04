import { Test, TestingModule } from '@nestjs/testing';
import { Role } from '@prisma/client';
import { UsersService } from './users.service';
import { PrismaService } from '../../prisma/prisma.service';

// Typed explicitly (rather than bare `jest.Mock`) so that reading a recorded
// call's arguments below type-checks without an `as` cast — a bare
// `jest.Mock<any, any, any>` makes `.mock.calls[0][0]` an unsafe member
// access under `no-unsafe-member-access`, which `lint:ci --max-warnings 0`
// rejects.
type UpdateArgs = [{ where: { id: string }; data: Record<string, unknown> }];

describe('UsersService', () => {
  let service: UsersService;
  let prisma: {
    user: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock<Promise<unknown>, UpdateArgs>;
    };
  };

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn<Promise<unknown>, UpdateArgs>(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [UsersService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  it('looks a user up by email', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u1' });

    const result = await service.findByEmail('a@example.test');

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'a@example.test' },
    });
    expect(result).toEqual({ id: 'u1' });
  });

  it('normalises email to lowercase before lookup', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);

    await service.findByEmail('MiXeD@Example.TEST');

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'mixed@example.test' },
    });
  });

  it('looks a user up by id', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u1' });

    const result = await service.findById('u1');

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'u1' },
    });
    expect(result).toEqual({ id: 'u1' });
  });

  it('creates a user with a lowercased email', async () => {
    prisma.user.create.mockResolvedValueOnce({ id: 'u1' });

    await service.create({ email: 'NEW@Example.TEST', passwordHash: 'digest' });

    expect(prisma.user.create).toHaveBeenCalledWith({
      data: { email: 'new@example.test', passwordHash: 'digest' },
    });
  });

  describe('ensureAdmin', () => {
    it('creates an ADMIN when the email is unknown', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(null);
      prisma.user.create.mockResolvedValueOnce({ id: 'u1', role: Role.ADMIN });

      const result = await service.ensureAdmin({
        email: 'Boss@Example.TEST',
        passwordHash: 'digest',
      });

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: {
          email: 'boss@example.test',
          passwordHash: 'digest',
          role: Role.ADMIN,
        },
      });
      expect(result.outcome).toBe('created');
    });

    it('promotes an existing CUSTOMER without touching the password', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({
        id: 'u1',
        role: Role.CUSTOMER,
        passwordHash: 'original-digest',
      });
      prisma.user.update.mockResolvedValueOnce({ id: 'u1', role: Role.ADMIN });

      const result = await service.ensureAdmin({
        email: 'boss@example.test',
        passwordHash: 'a-brand-new-digest',
      });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { role: Role.ADMIN },
      });

      // The decisive assertion: the update payload carries no passwordHash.
      // A bootstrap that silently resets a live account's credentials whenever
      // an env var is set is a foot-gun and an escalation path.
      const updateArg = prisma.user.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(updateArg.data).not.toHaveProperty('passwordHash');
      expect(result.outcome).toBe('promoted');
    });

    it('writes nothing when the user is already an ADMIN', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({
        id: 'u1',
        role: Role.ADMIN,
      });

      const result = await service.ensureAdmin({
        email: 'boss@example.test',
        passwordHash: 'digest',
      });

      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(result.outcome).toBe('unchanged');
    });
  });
});
