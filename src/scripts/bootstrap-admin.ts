import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AppConfig } from '../config/configuration';
import { PasswordHasherService } from '../modules/auth/password-hasher.service';
import {
  EnsureAdminOutcome,
  UsersService,
} from '../modules/users/users.service';

export interface BootstrapDeps {
  email: string | undefined;
  password: string | undefined;
  usersService: UsersService;
  passwordHasher: PasswordHasherService;
}

/**
 * The testable core. No process.exit, no context lifecycle — so a unit test
 * and the e2e suite can both drive the real logic.
 */
export async function bootstrapAdmin(
  deps: BootstrapDeps,
): Promise<EnsureAdminOutcome> {
  if (!deps.email) {
    throw new Error(
      'ADMIN_EMAIL is not set. The bootstrap has no default: refusing to run.',
    );
  }

  if (!deps.password) {
    throw new Error(
      'ADMIN_PASSWORD is not set. The bootstrap has no default: refusing to run.',
    );
  }

  const passwordHash = await deps.passwordHasher.hash(deps.password);
  const { outcome } = await deps.usersService.ensureAdmin({
    email: deps.email,
    passwordHash,
  });

  return outcome;
}

/**
 * CLI wrapper. Documented operator command, and the exact command CI runs:
 *
 *   node dist/scripts/bootstrap-admin.js
 *
 * Reads configuration through ConfigService rather than process.env, so the
 * `src/config/` rule holds and Joi validation applies to the script too.
 */
async function main(): Promise<void> {
  const logger = new Logger('BootstrapAdmin');
  const context = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const configService = context.get(ConfigService<AppConfig, true>);
    const outcome = await bootstrapAdmin({
      email: configService.get('admin.email', { infer: true }),
      password: configService.get('admin.password', { infer: true }),
      usersService: context.get(UsersService),
      passwordHasher: context.get(PasswordHasherService),
    });

    // Never log the password or the digest.
    logger.log(`Admin bootstrap complete: ${outcome}`);

    if (outcome === 'created') {
      logger.warn(
        'Change this password after first login and remove ADMIN_PASSWORD from the environment.',
      );
    }
  } finally {
    await context.close();
  }
}

// Only run when executed directly, so importing the core in a test does not
// boot an application context.
if (require.main === module) {
  main().catch((error: unknown) => {
    new Logger('BootstrapAdmin').error(
      error instanceof Error ? error.message : 'Admin bootstrap failed',
    );
    process.exitCode = 1;
  });
}
