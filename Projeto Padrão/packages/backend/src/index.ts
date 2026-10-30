import fastify from 'fastify';
import { ZodTypeProvider, jsonSchemaTransform } from 'fastify-type-provider-zod';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyCookie from '@fastify/cookie';
import fastifyJwt from '@fastify/jwt';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { getEnv } from './config/env';
import { errorHandler } from './utils/errors';
import { tenantRoutes } from './routes/tenants';
import { memberRoutes } from './routes/members';
import { professionalRoutes } from './routes/professionals';
import { serviceRoutes } from './routes/services';
import { clientRoutes } from './routes/clients';
import { appointmentRoutes } from './routes/appointments';
import { authRoutes } from './routes/auth';
import { webhookRoutes } from './routes/webhooks';

async function buildApp() {
  const env = getEnv();

  const app = fastify({
    logger: {
      level: env.NODE_ENV === 'production' ? 'info' : 'debug',
      transport: env.NODE_ENV !== 'production' ? {
        target: 'pino-pretty',
        options: { colorize: true },
      } : undefined,
    },
  }).withTypeProvider<ZodTypeProvider>();

  // Security
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: false, // Disable for API
  });

  // CORS
  await app.register(fastifyCors, {
    origin: env.FRONTEND_URL,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Rate limiting
  await app.register(fastifyRateLimit, {
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
  });

  // Cookies
  await app.register(fastifyCookie, {
    secret: env.JWT_SECRET,
    hook: 'onRequest',
  });

  // JWT
  await app.register(fastifyJwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.JWT_EXPIRES_IN },
    cookie: {
      cookieName: 'auth_token',
      signed: true,
    },
  });

  // Swagger/OpenAPI
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'Agenda Pro API',
        description: 'API para sistema de agendamento de barbearias, clínicas e dentistas',
        version: '1.0.0',
      },
      servers: [
        { url: `http://localhost:${env.PORT}`, description: 'Development' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    transform: jsonSchemaTransform,
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  });

  // Health check
  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  // API routes
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(tenantRoutes, { prefix: '/api/tenants' });
  await app.register(memberRoutes, { prefix: '/api/tenants/:tenant_id/members' });
  await app.register(professionalRoutes, { prefix: '/api/tenants/:tenant_id/professionals' });
  await app.register(serviceRoutes, { prefix: '/api/tenants/:tenant_id/services' });
  await app.register(clientRoutes, { prefix: '/api/tenants/:tenant_id/clients' });
  await app.register(appointmentRoutes, { prefix: '/api/tenants/:tenant_id/appointments' });
  await app.register(webhookRoutes, { prefix: '/api/webhooks' });

  // Global error handler
  app.setErrorHandler(errorHandler);

  // 404 handler
  app.setNotFoundHandler(async (request, reply) => {
    return reply.status(404).send({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: `Rota ${request.method} ${request.url} não encontrada`,
      },
    });
  });

  return app;
}

async function start() {
  const env = getEnv();
  const app = await buildApp();

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    console.log(`🚀 Server running on http://${env.HOST}:${env.PORT}`);
    console.log(`📚 API Docs: http://${env.HOST}:${env.PORT}/docs`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  process.exit(0);
});

start();