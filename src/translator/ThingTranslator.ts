/**
 * ThingTranslator
 * 
 * Translates WoT Thing Descriptions into MCP tools and resources.
 */

import { ThingDescription } from 'wot-typescript-definitions';
import {
  TranslatedThing,
  TranslatedProperty,
  TranslatedAction,
  TranslatedEvent
} from './types.js';
import { logger } from '../utils/Logger.js';

export class ThingTranslator {
  /**
   * Translate a WoT Thing Description into MCP-compatible structures
   */
  translate(td: ThingDescription): TranslatedThing {
    const thingId = this.extractThingId(td);
    logger.debug(`Translating Thing: ${thingId}`);

    return {
      id: thingId,
      title: td.title,
      description: td.description,
      properties: this.translateProperties(thingId, td),
      actions: this.translateActions(thingId, td),
      events: this.translateEvents(thingId, td)
    };
  }

  /**
   * Extract a stable ID from the Thing Description
   */
  private extractThingId(td: ThingDescription): string {
    if (td.id) {
      // Use last segment of URN/URI as ID
      const parts = td.id.split(/[:/]/);
      return this.sanitizeId(parts[parts.length - 1]);
    }
    // Fallback to sanitized title
    return this.sanitizeId(td.title);
  }

  /**
   * Sanitize string for use as ID (alphanumeric + hyphens only)
   */
  private sanitizeId(str: string): string {
    return str
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  /**
   * Translate TD properties to MCP resources
   */
  private translateProperties(thingId: string, td: ThingDescription): TranslatedProperty[] {
    if (!td.properties) return [];

    return Object.entries(td.properties).map(([name, prop]) => ({
      uri: `wot://${thingId}/properties/${name}`,
      name: prop.title || name,
      description: prop.description || `Property ${name} of ${td.title}`,
      mimeType: 'application/json',
      writable: !prop.readOnly,
      wotName: name,
      schema: prop
    }));
  }

  /**
   * Translate TD actions to MCP tools
   */
  private translateActions(thingId: string, td: ThingDescription): TranslatedAction[] {
    if (!td.actions) return [];

    return Object.entries(td.actions).map(([name, action]) => {
      const { inputSchema, inputWrapped } = this.buildActionInputSchema(action.input);

      return {
        name: `${thingId}_${name}`,
        description: action.description || `Execute ${name} on ${td.title}`,
        inputSchema,
        wotName: name,
        thingId,
        inputWrapped
      };
    });
  }

  /**
   * Build JSON Schema for action input
   * Returns both the schema and whether it was wrapped
   */
  private buildActionInputSchema(input?: unknown): { inputSchema: TranslatedAction['inputSchema']; inputWrapped: boolean } {
    if (!input) {
      return { inputSchema: { type: 'object', properties: {} }, inputWrapped: false };
    }

    const schema = input as Record<string, unknown>;

    // If input is already an object schema, use it
    if (schema.type === 'object' && schema.properties) {
      return {
        inputSchema: {
          type: 'object',
          properties: schema.properties as Record<string, unknown>,
          required: schema.required as string[] | undefined
        },
        inputWrapped: false
      };
    }

    // Wrap primitive input in an object
    return {
      inputSchema: {
        type: 'object',
        properties: {
          value: schema
        },
        required: ['value']
      },
      inputWrapped: true
    };
  }

  /**
   * Translate TD events to MCP resources (with subscription support)
   */
  private translateEvents(thingId: string, td: ThingDescription): TranslatedEvent[] {
    if (!td.events) return [];

    return Object.entries(td.events).map(([name, event]) => ({
      uri: `wot://${thingId}/events/${name}`,
      name: event.title || name,
      description: event.description || `Event stream for ${name} from ${td.title}`,
      mimeType: 'application/json',
      wotName: name,
      schema: event.data
    }));
  }
}
