import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from './users.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('UsersService', () => {
  let service: UsersService;
  let prisma: { user: { findUnique: jest.Mock; create: jest.Mock } };

  beforeEach(async () => {
    prisma = { user: { findUnique: jest.fn(), create: jest.fn() } };

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
});
