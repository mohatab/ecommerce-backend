export interface AppConfig {
  app: {
    port: number;
    env: string;
  };
  database: {
    url: string;
  };
  cors: {
    origin: string;
  };
}

export default (): AppConfig => ({
  app: {
    port: parseInt(process.env.PORT ?? '3000', 10),
    env: process.env.NODE_ENV ?? 'development',
  },
  database: {
    url: process.env.DATABASE_URL ?? '',
  },
  cors: {
    origin: process.env.CORS_ORIGIN ?? '*',
  },
});
