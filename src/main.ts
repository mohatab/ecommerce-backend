import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { configureApp, NEST_APP_OPTIONS } from './bootstrap';
import { AppConfig } from './config/configuration';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, NEST_APP_OPTIONS);

  configureApp(app);

  const configService = app.get(ConfigService<AppConfig, true>);
  const env = configService.get('app.env', { infer: true });
  const swaggerEnabled = env !== 'production';

  // Not served under production, and the reason is the mounting mechanism
  // rather than a general preference for quiet production builds.
  // SwaggerModule.setup() installs EXPRESS middleware, so it sits OUTSIDE the
  // Nest guard chain: neither JwtAuthGuard nor RolesGuard applies to it. An
  // ungated production container therefore publishes the complete API
  // surface, including every admin route and the maintenance trigger
  // POST /api/v1/admin/maintenance/:job/run.
  //
  // Gated on NODE_ENV with no new environment variable (D6): a
  // SWAGGER_ENABLED flag would be a knob with no current consumer. If a
  // staging deployment later wants docs under a production NODE_ENV, adding
  // the variable then is a one-line change made for a real reason.
  //
  // This does not affect test/swagger.e2e-spec.ts: that suite builds its own
  // document with SwaggerModule.createDocument and never requests this route.
  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('E-commerce Backend API')
      .setDescription('API documentation for the e-commerce backend')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, swaggerDocument);
  }

  const port = configService.get('app.port', { infer: true });
  await app.listen(port);

  // What does this container think it is. One line, answering the first
  // question anyone asks of a misbehaving deployment, and the entire
  // observability content of Phase 6 (D9) - structured logging, correlation
  // ids, metrics and tracing are all deferred with reasons.
  //
  // LEAKS NO SECRET, and the omissions are the point: no JWT_SECRET, no
  // PAYMENT_API_KEY, no PAYMENT_WEBHOOK_SECRET, and NO DATABASE_URL - that
  // one embeds a password and is the most tempting value to include here.
  // Every existing "never log" rule applies to this line.
  new Logger('Bootstrap').log(
    `Serving on port ${port} | env=${env} | ` +
      `trustProxyHops=${configService.get('app.trustProxyHops', { infer: true })} | ` +
      `paymentProvider=${configService.get('payments.provider', { infer: true })} | ` +
      `maintenanceJobs=${configService.get('maintenance.jobsEnabled', { infer: true }) ? 'enabled' : 'disabled'} | ` +
      `swagger=${swaggerEnabled ? 'served at /api/docs' : 'not served'}`,
  );
}

bootstrap().catch((error) => {
  console.error('Failed to bootstrap application', error);
  process.exit(1);
});
