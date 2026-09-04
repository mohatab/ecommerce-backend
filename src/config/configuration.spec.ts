import configuration from './configuration';

describe('configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('maps JWT settings from the environment', () => {
    process.env.JWT_SECRET = 'a'.repeat(32);
    process.env.JWT_ACCESS_TTL = '5m';
    process.env.JWT_REFRESH_TTL = '2d';

    const config = configuration();

    expect(config.jwt.secret).toBe('a'.repeat(32));
    expect(config.jwt.accessTtl).toBe('5m');
    expect(config.jwt.refreshTtl).toBe('2d');
  });

  it('falls back to the documented default lifetimes', () => {
    process.env.JWT_SECRET = 'b'.repeat(32);
    delete process.env.JWT_ACCESS_TTL;
    delete process.env.JWT_REFRESH_TTL;

    const config = configuration();

    expect(config.jwt.accessTtl).toBe('15m');
    expect(config.jwt.refreshTtl).toBe('7d');
  });

  // The factory used to return `secret: ''` here. Joi makes that unreachable
  // on the boot path, but the fallback only ever mattered on the paths Joi
  // does not run — and an empty HMAC key signs and verifies without
  // complaint, so nothing downstream would have reported the problem.
  it('throws rather than defaulting when JWT_SECRET is missing', () => {
    delete process.env.JWT_SECRET;

    expect(() => configuration()).toThrow(/JWT_SECRET/);
  });

  it('throws when JWT_SECRET is present but empty', () => {
    process.env.JWT_SECRET = '';

    expect(() => configuration()).toThrow(/JWT_SECRET/);
  });

  it('never yields an empty signing secret', () => {
    process.env.JWT_SECRET = 'c'.repeat(32);

    expect(configuration().jwt.secret).not.toBe('');
  });

  it('exposes admin bootstrap credentials when they are set', () => {
    process.env.JWT_SECRET = 'd'.repeat(32);
    process.env.ADMIN_EMAIL = 'boss@example.test';
    process.env.ADMIN_PASSWORD = 'Test1234!';

    const config = configuration();

    expect(config.admin.email).toBe('boss@example.test');
    expect(config.admin.password).toBe('Test1234!');
  });

  it('leaves admin bootstrap credentials undefined when absent', () => {
    process.env.JWT_SECRET = 'e'.repeat(32);
    delete process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_PASSWORD;

    const config = configuration();

    expect(config.admin.email).toBeUndefined();
    expect(config.admin.password).toBeUndefined();
  });
});
