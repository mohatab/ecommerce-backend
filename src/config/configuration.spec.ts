import configuration from './configuration';

describe('configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Neither payment variable has a default — `configuration()` throws
    // without them, exactly like JWT_SECRET. Unit tests never load `.env`, so
    // every test below that is not *about* one of them needs a baseline value
    // or it would fail for a reason it is not testing.
    process.env.PAYMENT_PROVIDER = 'fake';
    process.env.PAYMENT_WEBHOOK_SECRET = 'w'.repeat(20);
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

  it('maps the payments section from the environment', () => {
    process.env.JWT_SECRET = 'c'.repeat(32);
    process.env.PAYMENT_PROVIDER = 'stripe';
    process.env.PAYMENT_API_KEY = 'sk_test_example';
    process.env.PAYMENT_WEBHOOK_SECRET = 'w'.repeat(20);

    const config = configuration();

    expect(config.payments.provider).toBe('stripe');
    expect(config.payments.apiKey).toBe('sk_test_example');
    expect(config.payments.webhookSecret).toBe('w'.repeat(20));
  });

  // The factory used to default this to 'fake' — the single value
  // NODE_ENV=production forbids — so an unset variable would have silently
  // selected a provider that marks orders paid without taking money.
  it('refuses to start when PAYMENT_PROVIDER is missing, rather than defaulting to fake', () => {
    process.env.JWT_SECRET = 'd'.repeat(32);
    delete process.env.PAYMENT_PROVIDER;

    expect(() => configuration()).toThrow(/PAYMENT_PROVIDER/);
  });

  it('refuses to start when PAYMENT_WEBHOOK_SECRET is missing', () => {
    process.env.JWT_SECRET = 'd'.repeat(32);
    process.env.PAYMENT_PROVIDER = 'fake';
    delete process.env.PAYMENT_WEBHOOK_SECRET;

    expect(() => configuration()).toThrow(/PAYMENT_WEBHOOK_SECRET/);
  });
});
