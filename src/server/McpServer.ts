/**
 * McpServer
 * 
 * MCP server that exposes WoT Things as tools and resources.
 */

import express from 'express';
import http from 'http';
import crypto from 'crypto';
import cors from 'cors';
import { z } from 'zod';
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InMemoryEventStore } from '@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js';
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { EventBuffer } from './EventBuffer.js';
import { logger } from '../utils/Logger.js';

export type TransportMode = 'stdio' | 'streamable-http';
import {
  TranslatedThing,
  TranslatedProperty,
  TranslatedAction,
  TranslatedEvent
} from '../translator/types.js';

export type ToolStrategy = 'explicit' | 'generic';

export interface McpServerConfig {
  name: string;
  version: string;
  eventBufferSize?: number;
  toolStrategy?: ToolStrategy;
}

type PropertyReader = (thingId: string, propertyName: string) => Promise<unknown>;
type PropertyWriter = (thingId: string, propertyName: string, value: unknown) => Promise<void>;
type ActionInvoker = (thingId: string, actionName: string, params?: unknown) => Promise<unknown>;

export class McpServer {
  private config: McpServerConfig;
  private eventBuffer: EventBuffer;
  
  // Active servers
  private stdioServer?: SdkMcpServer;
  // Map session ID to server instance and transport
  private sessions = new Map<string, { server: SdkMcpServer, transport: StreamableHTTPServerTransport }>();
  // Track subscriptions per server instance
  private serverSubscriptions = new Map<SdkMcpServer, Set<string>>();

  private httpServer?: express.Express;
  private serverInstance?: http.Server;
  
  // Registry (buffers definitions until servers are created)
  private things: Map<string, TranslatedThing> = new Map();
  private properties: Map<string, TranslatedProperty> = new Map();
  private actions: Map<string, TranslatedAction> = new Map();
  private events: Map<string, TranslatedEvent> = new Map();

  // Callbacks to WoT client
  private propertyReader?: PropertyReader;
  private propertyWriter?: PropertyWriter;
  private actionInvoker?: ActionInvoker;

  constructor(config: McpServerConfig) {
    this.config = config;
    this.eventBuffer = new EventBuffer({
      maxEventsPerUri: config.eventBufferSize ?? 100
    });
  }

  /**
   * Create a new, empty MCP server instance
   */
  private createMcpServerInstance(): SdkMcpServer {
    return new SdkMcpServer(
      { name: this.config.name, version: this.config.version },
      {
        capabilities: {
          resources: {
            subscribe: true,
            listChanged: true
          },
          tools: {}
        }
      }
    );
  }

  /**
   * Initialize a server instance with all currently registered things
   */
  private initializeServer(server: SdkMcpServer): void {
    const strategy = this.config.toolStrategy || 'explicit';

    if (strategy === 'explicit') {
      // Register properties
      for (const prop of this.properties.values()) {
        this.registerPropertyGetterToolOnServer(server, prop);
        if (prop.writable) {
          this.registerPropertySetterToolOnServer(server, prop);
        }
      }

      // Register actions
      for (const action of this.actions.values()) {
        this.registerActionToolOnServer(server, action);
      }
    } else {
      // Generic Strategy
      this.registerGenericTools(server);
    }

    // Register events (always exposed as resources)
    for (const event of this.events.values()) {
      this.registerEventResourceOnServer(server, event);
    }

    // Setup subscription handlers
    this.setupSubscriptionHandlers(server);
  }

  private registerGenericTools(server: SdkMcpServer): void {
    // Tool: list_devices
    server.registerTool(
      "list_devices",
      {
        description: "List all available devices and their capabilities (properties, actions, events). Use this to discover what you can do.",
        inputSchema: z.object({})
      },
      async () => {
        const removeForms = (schema: any) => {
          if (!schema || typeof schema !== 'object') return schema;
          // Remove protocol binding fields that are irrelevant to the LLM
          const { forms, op, href, contentType, 'htv:methodName': method, subprotocol, ...rest } = schema;
          return rest;
        };

        const devices = Array.from(this.things.values()).map(thing => ({
          id: thing.id,
          title: thing.title,
          description: thing.description,
          properties: thing.properties.map(p => ({
            name: p.wotName,
            description: p.description,
            type: (p.schema as any)?.type || 'unknown',
            writable: p.writable,
            schema: removeForms(p.schema)
          })),
          actions: thing.actions.map(a => ({
            name: a.wotName,
            description: a.description,
            inputSchema: a.inputSchema
          })),
          events: thing.events.map(e => ({
            name: e.name,
            description: e.description
          }))
        }));
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(devices, null, 2)
          }]
        };
      }
    );

    // Tool: read_property
    server.registerTool(
      "read_property",
      {
        description: "Read a property from a device.",
        inputSchema: z.object({
          device_id: z.string().describe("The ID of the device"),
          property_name: z.string().describe("The name of the property to read")
        })
      },
      async (args: any) => {
        try {
          const thing = this.things.get(args.device_id);
          if (!thing) throw new Error(`Device '${args.device_id}' not found.`);
          
          const prop = thing.properties.find(p => p.wotName === args.property_name);
          if (!prop) throw new Error(`Property '${args.property_name}' not found on device '${args.device_id}'.`);

          return await this.invokePropertyGetter(prop);
        } catch (error: any) {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: `Error: ${error.message || error}`
            }]
          };
        }
      }
    );

    // Tool: write_property
    server.registerTool(
      "write_property",
      {
        description: "Write a value to a device property.",
        inputSchema: z.object({
          device_id: z.string().describe("The ID of the device"),
          property_name: z.string().describe("The name of the property to write"),
          value: z.any().describe("The value to write. Ensure it matches the property schema.")
        })
      },
      async (args: any) => {
        try {
          const thing = this.things.get(args.device_id);
          if (!thing) throw new Error(`Device '${args.device_id}' not found.`);
          
          const prop = thing.properties.find(p => p.wotName === args.property_name);
          if (!prop) throw new Error(`Property '${args.property_name}' not found on device '${args.device_id}'.`);
          if (!prop.writable) throw new Error(`Property '${args.property_name}' is read-only.`);

          return await this.invokePropertySetter(prop, { value: args.value });
        } catch (error: any) {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: `Error: ${error.message || error}`
            }]
          };
        }
      }
    );

    // Tool: invoke_action
    server.registerTool(
      "invoke_action",
      {
        description: "Invoke an action on a device.",
        inputSchema: z.object({
          device_id: z.string().describe("The ID of the device"),
          action_name: z.string().describe("The name of the action to invoke"),
          params: z.any().optional().describe("Parameters for the action, if required by the schema.")
        })
      },
      async (args: any) => {
        try {
          const thing = this.things.get(args.device_id);
          if (!thing) throw new Error(`Device '${args.device_id}' not found.`);
          
          const action = thing.actions.find(a => a.wotName === args.action_name);
          if (!action) throw new Error(`Action '${args.action_name}' not found on device '${args.device_id}'.`);

          return await this.invokeActionTool(action, args.params);
        } catch (error: any) {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: `Error: ${error.message || error}`
            }]
          };
        }
      }
    );
  }

  /**
   * Set up handlers for resource subscription requests on a specific server
   */
  private setupSubscriptionHandlers(server: SdkMcpServer): void {
    if (!this.serverSubscriptions.has(server)) {
      this.serverSubscriptions.set(server, new Set());
    }

    server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
      const uri = request.params.uri;
      const subs = this.serverSubscriptions.get(server);
      if (subs) {
        subs.add(uri);
        logger.info(`Client subscribed to: ${uri}`);
      }
      return {};
    });

    server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
      const uri = request.params.uri;
      const subs = this.serverSubscriptions.get(server);
      if (subs) {
        subs.delete(uri);
        logger.info(`Client unsubscribed from: ${uri}`);
      }
      return {};
    });
  }

  /**
   * Set callbacks for WoT operations
   */
  setCallbacks(callbacks: {
    readProperty: PropertyReader;
    writeProperty: PropertyWriter;
    invokeAction: ActionInvoker;
  }): void {
    this.propertyReader = callbacks.readProperty;
    this.propertyWriter = callbacks.writeProperty;
    this.actionInvoker = callbacks.invokeAction;
  }

  /**
   * Register a translated Thing
   */
  registerThing(thing: TranslatedThing): void {
    this.things.set(thing.id, thing);

    // Store definitions in maps
    for (const prop of thing.properties) {
      this.properties.set(prop.uri, prop);
    }
    for (const action of thing.actions) {
      this.actions.set(action.name, action);
    }
    for (const event of thing.events) {
      this.events.set(event.uri, event);
      this.eventBuffer.initialize(event.uri);
    }

    // Apply to all currently active servers
    this.applyThingToAllServers(thing);
  }

  private applyThingToAllServers(thing: TranslatedThing) {
    const servers: SdkMcpServer[] = [];
    if (this.stdioServer) servers.push(this.stdioServer);
    for (const session of this.sessions.values()) {
      servers.push(session.server);
    }

    for (const server of servers) {
      const strategy = this.config.toolStrategy || 'explicit';
      
      if (strategy === 'explicit') {
        for (const prop of thing.properties) {
          this.registerPropertyGetterToolOnServer(server, prop);
          if (prop.writable) {
            this.registerPropertySetterToolOnServer(server, prop);
          }
        }
        for (const action of thing.actions) {
          this.registerActionToolOnServer(server, action);
        }
      }
      
      for (const event of thing.events) {
        this.registerEventResourceOnServer(server, event);
      }
    }
  }

  private registerPropertyGetterToolOnServer(server: SdkMcpServer, prop: TranslatedProperty): void {
    // Parse URI to extract thingId and propertyName
    // URI format: wot://<thingId>/properties/<propertyName>
    const match = prop.uri.match(/^wot:\/\/([^/]+)\/properties\/(.+)$/);
    
    let toolName: string;
    if (match) {
      const thingId = match[1].replace(/[^a-z0-9]/gi, '_');
      const propName = match[2].replace(/[^a-z0-9]/gi, '_');
      toolName = `get_${propName}_${thingId}`;
    } else {
      // Fallback to old behavior if URI format doesn't match
      toolName = `get_${prop.uri.replace(/^wot:\/\//, '').replace(/[^a-z0-9]/gi, '_')}`;
    }

    server.registerTool(
      toolName,
      {
        description: `Get ${prop.name}. ${prop.description || ''}`,
        inputSchema: z.object({})
      },
      async (args: Record<string, unknown>) => {
        return this.invokePropertyGetter(prop);
      }
    );
  }

  private registerEventResourceOnServer(server: SdkMcpServer, event: TranslatedEvent): void {
    server.registerResource(
      event.name,
      event.uri,
      {
        description: event.description,
        mimeType: event.mimeType
      },
      async (uri) => {
        return this.readEventResource(event);
      }
    );
  }

  private registerActionToolOnServer(server: SdkMcpServer, action: TranslatedAction): void {
    const zodSchema = this.jsonSchemaToZodObject(action.inputSchema);
    
    const thingId = action.thingId.replace(/[^a-z0-9]/gi, '_');
    const actionName = action.wotName.replace(/[^a-z0-9]/gi, '_');
    const toolName = `${actionName}_${thingId}`;
    
    server.registerTool(
      toolName,
      {
        description: action.description,
        inputSchema: zodSchema
      },
      async (args: Record<string, unknown>) => {
        return this.invokeActionTool(action, args);
      }
    );
  }

  private registerPropertySetterToolOnServer(server: SdkMcpServer, prop: TranslatedProperty): void {
    // Parse URI to extract thingId and propertyName
    // URI format: wot://<thingId>/properties/<propertyName>
    const match = prop.uri.match(/^wot:\/\/([^/]+)\/properties\/(.+)$/);
    
    let toolName: string;
    if (match) {
      const thingId = match[1].replace(/[^a-z0-9]/gi, '_');
      const propName = match[2].replace(/[^a-z0-9]/gi, '_');
      toolName = `set_${propName}_${thingId}`;
    } else {
      // Fallback to old behavior if URI format doesn't match
      toolName = `set_${prop.uri.replace(/^wot:\/\//, '').replace(/[^a-z0-9]/gi, '_')}`;
    }

    const valueSchema = this.jsonSchemaToZod(prop.schema || { type: 'string' });
    const zodSchema = { value: valueSchema };
    
    server.registerTool(
      toolName,
      {
        description: `Set ${prop.name}`,
        inputSchema: zodSchema
      },
      async (args: Record<string, unknown>) => {
        return this.invokePropertySetter(prop, args);
      }
    );
  }

  /**
   * Handle incoming WoT event
   */
  async handleWotEvent(thingId: string, eventName: string, data: unknown): Promise<void> {
    const uri = `wot://${thingId}/events/${eventName}`;
    
    // Buffer the event
    this.eventBuffer.push(uri, eventName, data);

    // Notify all subscribed servers
    const servers: SdkMcpServer[] = [];
    if (this.stdioServer) servers.push(this.stdioServer);
    for (const session of this.sessions.values()) {
      servers.push(session.server);
    }

    for (const server of servers) {
      const subs = this.serverSubscriptions.get(server);
      if (server.server.transport && subs && subs.has(uri)) {
        try {
          await server.server.notification({
            method: 'notifications/resources/updated',
            params: { uri }
          });
        } catch (err) {
          // Ignore errors
        }
      }
    }
  }

  /**
   * Notify that resource list has changed (e.g., new device discovered)
   */
  async notifyResourceListChanged(): Promise<void> {
    const servers: SdkMcpServer[] = [];
    if (this.stdioServer) servers.push(this.stdioServer);
    for (const session of this.sessions.values()) {
      servers.push(session.server);
    }

    for (const server of servers) {
      if (server.server.transport) {
        try {
          await server.server.notification({
            method: 'notifications/resources/list_changed'
          });
        } catch (err) {
          // Ignore errors
        }
      }
    }
  }

  /**
   * Start the MCP server with the specified transport mode
   */
  async start(mode: TransportMode = 'stdio', port: number = 3000): Promise<void> {
    if (mode === 'stdio') {
      this.stdioServer = this.createMcpServerInstance();
      this.initializeServer(this.stdioServer);
      const transport = new StdioServerTransport();
      await this.stdioServer.connect(transport);
    } else if (mode === 'streamable-http') {
      this.httpServer = express();
      this.httpServer.use(cors({
          "origin": "*",
          "methods": "GET,POST,DELETE",
          "preflightContinue": false,
          "optionsSuccessStatus": 204,
          "exposedHeaders": ['mcp-session-id', 'last-event-id', 'mcp-protocol-version']
      }));

      this.httpServer.all("/mcp", async (req, res) => {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        if (!sessionId) {
          // New session
          const newSessionId = crypto.randomUUID();
          const server = this.createMcpServerInstance();
          this.initializeServer(server);
          
          const eventStore = new InMemoryEventStore();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => newSessionId,
            eventStore,
            onsessioninitialized: (id) => {
              logger.info(`Session initialized with ID: ${id}`);
              this.sessions.set(id, { server, transport });
            }
          });

          transport.onclose = () => {
            logger.info(`Session ${newSessionId} closed`);
            this.sessions.delete(newSessionId);
            this.serverSubscriptions.delete(server);
          };

          await server.connect(transport);

          if (req.method === "GET") {
              res.setHeader("mcp-session-id", newSessionId);
              return transport.handleRequest(req, res);
          }
          
          // Handle POST for new session if applicable
          return transport.handleRequest(req, res);
        } else {
          // Existing session
          const session = this.sessions.get(sessionId);
          if (!session) {
            return res.status(404).send("Session not found");
          }
          return session.transport.handleRequest(req, res);
        }
      });

      this.serverInstance = this.httpServer.listen(port, () => {
        logger.info(`HTTP server listening on port ${port} (accessible via http://localhost:${port}/mcp or http://<your-ip>:${port}/mcp)`);
      });
    } else {
      throw new Error(`Unknown transport mode: ${mode}. Supported modes are 'stdio' and 'streamable-http'.`);
    }
  }

  /**
   * Stop the MCP server and clean up resources
   */
  async stop(): Promise<void> {
    this.serverSubscriptions.clear();
    
    if (this.httpServer) {
      // Close all session transports
      for (const [id, session] of this.sessions) {
        try {
          logger.info(`Closing transport for session ${id}`);
          await session.transport.close();
        } catch (error) {
          logger.error(`Error closing transport for session ${id}:`, error);
        }
      }
      this.sessions.clear();
      this.httpServer = undefined;
    }

    if (this.serverInstance) {
      await new Promise<void>((resolve, reject) => {
        this.serverInstance!.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      this.serverInstance = undefined;
    }

    if (this.stdioServer) {
      await this.stdioServer.close();
      this.stdioServer = undefined;
    }
  }

  private async invokePropertyGetter(prop: TranslatedProperty) {
    if (!this.propertyReader) {
      throw new Error('Property reader not configured');
    }

    const parts = prop.uri.match(/wot:\/\/([^/]+)\/properties\/(.+)/);
    if (!parts) throw new Error(`Invalid property URI: ${prop.uri}`);

    const [, thingId, propName] = parts;
    const value = await this.propertyReader(thingId, propName);

    // Build a rich response with value and metadata from the property schema
    const schema = prop.schema as Record<string, unknown> | undefined;
    const response: Record<string, unknown> = {
      name: prop.wotName,
      value: value,
    };

    // Include relevant schema metadata if available
    if (schema) {
      if (schema.unit !== undefined) response.unit = schema.unit;
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(response, null, 2)
      }]
    };
  }

  private readEventResource(event: TranslatedEvent) {
    const events = this.eventBuffer.getRecent(event.uri, 50);
    
    return {
      contents: [{
        uri: event.uri,
        mimeType: event.mimeType,
        text: JSON.stringify({
          events,
          totalCount: this.eventBuffer.count(event.uri),
          lastUpdated: this.eventBuffer.getLastUpdated(event.uri)
        }, null, 2)
      }]
    };
  }

  private async invokeActionTool(action: TranslatedAction, args?: Record<string, unknown>) {
    if (!this.actionInvoker) {
      throw new Error('Action invoker not configured');
    }

    // If the input was wrapped (primitive type), unwrap it
    const params = action.inputWrapped && args ? args.value : args;
    const result = await this.actionInvoker(action.thingId, action.wotName, params);

    return {
      content: [{
        type: 'text' as const,
        text: result !== undefined 
          ? JSON.stringify(result, null, 2)
          : 'Action executed successfully'
      }]
    };
  }

  private async invokePropertySetter(prop: TranslatedProperty, args?: Record<string, unknown>) {
    if (!this.propertyWriter) {
      throw new Error('Property writer not configured');
    }

    const parts = prop.uri.match(/wot:\/\/([^/]+)\/properties\/(.+)/);
    if (!parts) throw new Error(`Invalid property URI: ${prop.uri}`);

    const [, thingId, propName] = parts;
    await this.propertyWriter(thingId, propName, args?.value);

    return {
      content: [{
        type: 'text' as const,
        text: `Property ${propName} updated successfully`
      }]
    };
  }

  /**
   * Convert a JSON Schema to a Zod schema
   * Supports basic types: string, number, integer, boolean, array, object
   */
  private jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
    const type = schema.type as string | undefined;
    const description = schema.description as string | undefined;

    let zodSchema: z.ZodType;

    switch (type) {
      case 'string':
        let strSchema = z.string();
        if (schema.enum) {
          const enumValues = schema.enum as string[];
          zodSchema = z.enum(enumValues as [string, ...string[]]);
        } else {
          zodSchema = strSchema;
        }
        break;

      case 'number':
        let numSchema = z.number();
        if (typeof schema.minimum === 'number') {
          numSchema = numSchema.min(schema.minimum);
        }
        if (typeof schema.maximum === 'number') {
          numSchema = numSchema.max(schema.maximum);
        }
        zodSchema = numSchema;
        break;

      case 'integer':
        let intSchema = z.number().int();
        if (typeof schema.minimum === 'number') {
          intSchema = intSchema.min(schema.minimum);
        }
        if (typeof schema.maximum === 'number') {
          intSchema = intSchema.max(schema.maximum);
        }
        zodSchema = intSchema;
        break;

      case 'boolean':
        zodSchema = z.boolean();
        break;

      case 'array':
        const itemsSchema = schema.items as Record<string, unknown> | undefined;
        if (itemsSchema) {
          zodSchema = z.array(this.jsonSchemaToZod(itemsSchema));
        } else {
          zodSchema = z.array(z.unknown());
        }
        break;

      case 'object':
        const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
        const required = schema.required as string[] | undefined;
        if (properties) {
          const shape: Record<string, z.ZodType> = {};
          for (const [key, propSchema] of Object.entries(properties)) {
            let propZod = this.jsonSchemaToZod(propSchema);
            // Make optional if not in required array
            if (!required || !required.includes(key)) {
              propZod = propZod.optional();
            }
            shape[key] = propZod;
          }
          zodSchema = z.object(shape);
        } else {
          zodSchema = z.object({});
        }
        break;

      default:
        // Fallback for unknown types
        zodSchema = z.unknown();
    }

    if (description) {
      zodSchema = zodSchema.describe(description);
    }

    return zodSchema;
  }

  /**
   * Convert a JSON Schema object definition to a Zod raw shape (for MCP SDK)
   * Returns a record where values are Zod schemas
   */
  private jsonSchemaToZodObject(schema: { properties?: Record<string, unknown>; required?: string[] }): Record<string, z.ZodType> {
    const properties = schema.properties || {};
    const required = schema.required || [];
    const shape: Record<string, z.ZodType> = {};

    for (const [key, propSchema] of Object.entries(properties)) {
      let propZod = this.jsonSchemaToZod(propSchema as Record<string, unknown>);
      // Make optional if not in required array
      if (!required.includes(key)) {
        propZod = propZod.optional();
      }
      shape[key] = propZod;
    }

    return shape;
  }
}
