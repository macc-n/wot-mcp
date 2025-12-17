/**
 * EventBuffer
 * 
 * Buffers WoT events for MCP resource access.
 * Maintains a fixed-size circular buffer per event URI.
 */

export interface BufferedEvent {
  timestamp: string;
  data: unknown;
  eventType: string;
}

export interface EventBufferOptions {
  // Maximum events to retain per URI (default: 100)
  maxEventsPerUri?: number;
  // Event TTL in milliseconds (default: 1 hour)
  eventTtlMs?: number;
}

export class EventBuffer {
  private buffers: Map<string, BufferedEvent[]> = new Map();
  private maxEvents: number;
  private eventTtlMs: number;
  private lastUpdated: Map<string, string> = new Map();

  constructor(options: EventBufferOptions = {}) {
    this.maxEvents = options.maxEventsPerUri ?? 100;
    this.eventTtlMs = options.eventTtlMs ?? 60 * 60 * 1000; // 1 hour
  }

  /**
   * Add an event to the buffer
   */
  push(uri: string, eventType: string, data: unknown): BufferedEvent {
    if (!this.buffers.has(uri)) {
      this.buffers.set(uri, []);
    }

    const buffer = this.buffers.get(uri)!;
    const event: BufferedEvent = {
      timestamp: new Date().toISOString(),
      eventType,
      data
    };

    buffer.push(event);

    // Enforce max size (circular buffer)
    if (buffer.length > this.maxEvents) {
      buffer.shift();
    }

    this.lastUpdated.set(uri, event.timestamp);
    return event;
  }

  /**
   * Get all events for a URI
   */
  get(uri: string): BufferedEvent[] {
    this.pruneExpired(uri);
    return this.buffers.get(uri) ?? [];
  }

  /**
   * Get events since a specific timestamp
   */
  getSince(uri: string, since: string): BufferedEvent[] {
    const events = this.get(uri);
    const sinceDate = new Date(since).getTime();
    return events.filter(e => new Date(e.timestamp).getTime() > sinceDate);
  }

  /**
   * Get the most recent N events
   */
  getRecent(uri: string, count: number): BufferedEvent[] {
    const events = this.get(uri);
    return events.slice(-count);
  }

  /**
   * Get last updated timestamp for a URI
   */
  getLastUpdated(uri: string): string | undefined {
    return this.lastUpdated.get(uri);
  }

  /**
   * Check if buffer has any events
   */
  has(uri: string): boolean {
    return this.buffers.has(uri) && this.buffers.get(uri)!.length > 0;
  }

  /**
   * Get total event count for a URI
   */
  count(uri: string): number {
    return this.buffers.get(uri)?.length ?? 0;
  }

  /**
   * Get all URIs with buffered events
   */
  getUris(): string[] {
    return Array.from(this.buffers.keys());
  }

  /**
   * Clear events for a URI
   */
  clear(uri: string): void {
    this.buffers.delete(uri);
    this.lastUpdated.delete(uri);
  }

  /**
   * Clear all events
   */
  clearAll(): void {
    this.buffers.clear();
    this.lastUpdated.clear();
  }

  /**
   * Initialize buffer for a URI (even if no events yet)
   */
  initialize(uri: string): void {
    if (!this.buffers.has(uri)) {
      this.buffers.set(uri, []);
    }
  }

  /**
   * Remove expired events from a buffer
   */
  private pruneExpired(uri: string): void {
    const buffer = this.buffers.get(uri);
    if (!buffer) return;

    const cutoff = Date.now() - this.eventTtlMs;
    const pruned = buffer.filter(e => new Date(e.timestamp).getTime() > cutoff);
    
    if (pruned.length !== buffer.length) {
      this.buffers.set(uri, pruned);
    }
  }

  /**
   * Get summary statistics
   */
  getStats(): { totalEvents: number; uriCount: number; oldestEvent?: string } {
    let totalEvents = 0;
    let oldestEvent: string | undefined;

    for (const [, buffer] of this.buffers) {
      totalEvents += buffer.length;
      if (buffer.length > 0) {
        const oldest = buffer[0].timestamp;
        if (!oldestEvent || oldest < oldestEvent) {
          oldestEvent = oldest;
        }
      }
    }

    return {
      totalEvents,
      uriCount: this.buffers.size,
      oldestEvent
    };
  }
}
