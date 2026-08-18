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
});
