import { Injectable, type MessageEvent } from '@nestjs/common';
import { map, Observable, Subject } from 'rxjs';
import type { LiveEvent } from './live-monitoring.types.js';

@Injectable()
export class LiveEventService {
  private readonly subject = new Subject<LiveEvent>();

  emit(event: { type: string; timestamp?: string; [key: string]: unknown }) {
    this.subject.next({ ...event, timestamp: event.timestamp ?? new Date().toISOString() });
  }

  events(): Observable<MessageEvent> {
    return this.subject.pipe(map((event) => ({ data: event })));
  }
}
