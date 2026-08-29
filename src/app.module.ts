import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { HealthController } from './health/health.controller.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { FxModule } from './modules/fx/fx.module.js';
import { TransactionsModule } from './modules/transactions/transactions.module.js';
import { BaselinesModule } from './modules/baselines/baselines.module.js';
import { IncidentsModule } from './modules/incidents/incidents.module.js';
import { DetectionModule } from './modules/detection/detection.module.js';
import { AnalyticsModule } from './modules/analytics/analytics.module.js';
import { DemoModule } from './modules/demo/demo.module.js';
import { AgentModule } from './modules/agent/agent.module.js';
import { GraphModule } from './modules/graph/graph.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    FxModule,
    TransactionsModule,
    BaselinesModule,
    IncidentsModule,
    DetectionModule,
    AnalyticsModule,
    DemoModule,
    AgentModule,
    GraphModule
  ],
  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule {}
