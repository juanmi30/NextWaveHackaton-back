import { Module } from '@nestjs/common';

import { BaselinesModule } from '../baselines/baselines.module.js';
import { DetectionModule } from '../detection/detection.module.js';
import { IncidentsModule } from '../incidents/incidents.module.js';
import { PredictionModule } from '../prediction/prediction.module.js';
import { TransactionsModule } from '../transactions/transactions.module.js';

import { GraphController } from './graph.controller.js';
import { GraphService } from './graph.service.js';

import { UnifiedGraphController } from './unified-graph.controller.js';
import { UnifiedGraphService } from './unified-graph.service.js';

@Module({
  imports: [
    IncidentsModule,
    TransactionsModule,
    BaselinesModule,
    DetectionModule,

    /*
     * NUEVO:
     *
     * Graph puede utilizar el modelo
     * de predicción directamente.
     */
    PredictionModule,
  ],

  controllers: [
    /*
     * Endpoints legacy:
     *
     * /incidents/:id/graph
     * /incidents/:id/graph/explorer
     */
    GraphController,

    /*
     * Nuevo endpoint unificado:
     *
     * /graph/unified
     */
    UnifiedGraphController,
  ],

  providers: [
    GraphService,

    UnifiedGraphService,
  ],
})
export class GraphModule {}