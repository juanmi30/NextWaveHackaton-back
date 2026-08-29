import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { HealthController } from './health/health.controller.js';
import { AnalyticsModule } from './modules/analytics/analytics.module.js';
import { DemoModule } from './modules/demo/demo.module.js';
import { IncidentsModule } from './modules/incidents/incidents.module.js';
import { TransactionsModule } from './modules/transactions/transactions.module.js';
import { PrismaModule } from './prisma/prisma.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    TransactionsModule,
    AnalyticsModule,
    IncidentsModule,
    DemoModule,
  ],
  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule {}
