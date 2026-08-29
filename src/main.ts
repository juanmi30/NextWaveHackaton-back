import 'dotenv/config';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

type CorsCallback = (err: Error | null, allow?: boolean) => void;

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api', { exclude: ['health'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const allowed = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.enableCors({
    origin: (origin: string | undefined, cb: CorsCallback) => {
      // sin Origin = curl, Postman, healthcheck de Railway
      if (!origin) return cb(null, true);
      const ok =
        allowed.includes(origin) ||
        /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin);
      return ok ? cb(null, true) : cb(new Error(`CORS bloqueado: ${origin}`), false);
    },
    credentials: true,
  });

  app.enableShutdownHooks();

  // Railway inyecta PORT. Hay que escuchar en 0.0.0.0, no en localhost.
  const port = Number(process.env.PORT) || 3000;
  await app.listen(port, '0.0.0.0');
  console.log(`API escuchando en 0.0.0.0:${port}`);
}

void bootstrap();
