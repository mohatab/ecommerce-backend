import { releaseE2eDatabaseLock } from './helpers/e2e-lock';

export default async function globalTeardown(): Promise<void> {
  await releaseE2eDatabaseLock();
}
