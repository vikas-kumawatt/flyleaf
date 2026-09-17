// OpenAPI registration and metadata configuration (FN-80, Architecture §6).

import type { FastifyInstance } from 'fastify';
import fastifySwagger from '@fastify/swagger';

export async function registerSwagger(app: FastifyInstance) {
  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Flyleaf API',
        description: 'The social reading tracker backend (PRD §24, Architecture §6).',
        version: '0.0.1',
      },
      servers: [
        {
          url: '/v1',
          description: 'Default API path',
        },
      ],
      components: {
        securitySchemes: {
          BearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: '15-minute access JWT (FN-63)',
          },
        },
      },
      tags: [
        { name: 'Auth', description: 'Authentication, rotating sessions, and profiles' },
        { name: 'Catalog', description: 'Works, editions, and search' },
        { name: 'Admin Dedupe', description: 'Duplicate detection review queue and 30-day undo (FN-51)' },
        { name: 'Admin Auth', description: 'Administrator authentication, 2FA, and session management (FN-90)' },
        { name: 'Admin Audit', description: 'Non-negotiable administrative audit log (FN-93)' },
      ],
    },
  });
}

export * from './schemas.js';
