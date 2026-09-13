import { Controller, Get, Module } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../../src/common/decorators/roles.decorator';

// A role-restricted route that exists only for tests. It lets the guard chain
// be asserted before any admin domain route exists, and it is never imported
// by AppModule, so it ships in no production build.
@Controller({ path: 'admin-probe', version: '1' })
@Roles(Role.ADMIN)
export class AdminProbeController {
  @Get()
  ping(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [AdminProbeController] })
export class AdminProbeModule {}
