/**
 * WotMcpBridge
 * 
 * Main entry point that orchestrates the WoT client, translator, and MCP server.
 */

import { ThingDescription } from 'wot-typescript-definitions';
import { WotClient, WotClientConfig } from '../client/WotClient.js';
import { ThingTranslator } from '../translator/ThingTranslator.js';
import { McpServer, TransportMode, ToolStrategy } from '../server/McpServer.js';
import { TranslatedThing } from '../translator/types.js';
import { logger } from '../utils/Logger.js';

export interface WotMcpBridgeConfig {
  // MCP server name
  name: string;
  // MCP server version
  version: string;
  // WoT client configuration
  wot?: WotClientConfig;
  // Maximum events to buffer per event type
  eventBufferSize?: number;
  // Tool generation strategy
  toolStrategy?: ToolStrategy;
}

export class WotMcpBridge {
  private client: WotClient;
  private translator: ThingTranslator;
  private mcpServer: McpServer;
  private translatedThings: Map<string, TranslatedThing> = new Map();

  constructor(config: WotMcpBridgeConfig) {
    this.client = new WotClient(config.wot);
    this.translator = new ThingTranslator();
    this.mcpServer = new McpServer({
      name: config.name,
      version: config.version,
      eventBufferSize: config.eventBufferSize,
      toolStrategy: config.toolStrategy
    });

    // Wire up MCP server callbacks to WoT client
    this.mcpServer.setCallbacks({
      readProperty: (thingId, propName) => this.client.readProperty(thingId, propName),
      writeProperty: (thingId, propName, value) => this.client.writeProperty(thingId, propName, value),
      invokeAction: (thingId, actionName, params) => this.client.invokeAction(thingId, actionName, params)
    });
  }

  /**
   * Start the bridge (both client and server)
   */
  async start(): Promise<void> {
    await this.startClient();
    await this.startServer();
  }

  /**
   * Start only the WoT client
   */
  async startClient(): Promise<void> {
    await this.client.start();
  }

  /**
   * Start only the MCP server
   * @param mode - Transport mode: 'stdio' (default) or 'streamable-http'
   * @param port - Port number for streamable-http mode (default: 3000)
   */
  async startServer(mode: TransportMode = 'stdio', port: number = 3000): Promise<void> {
    await this.mcpServer.start(mode, port);
  }

  /**
   * Stop the bridge and clean up
   */
  async stop(): Promise<void> {
    // Stop MCP server first, then WoT client
    try {
      await this.mcpServer.stop();
    } catch (err) {
      logger.error('Error stopping MCP server:', err);
    }

    await this.client.stop();
  }

  /**
   * Add a Thing to the bridge
   * 
   * @param tdOrUrl - Thing Description object or URL to fetch it from
   * @param subscribeToEvents - Whether to automatically subscribe to all events (default: true)
   */
  async addThing(tdOrUrl: string | ThingDescription, subscribeToEvents = true): Promise<TranslatedThing> {
    // Consume the thing via WoT client
    const { thing, td } = await this.client.consume(tdOrUrl);

    // Translate TD to MCP structures
    const translated = this.translator.translate(td);
    this.translatedThings.set(translated.id, translated);

    // Register with MCP server
    this.mcpServer.registerThing(translated);

    // Subscribe to WoT events if requested
    if (subscribeToEvents && td.events) {
      await this.client.subscribeAllEvents(translated.id, (eventName, data) => {
        this.mcpServer.handleWotEvent(translated.id, eventName, data);
      });
    }

    // Notify MCP clients that resource list changed
    await this.mcpServer.notifyResourceListChanged();

    return translated;
  }

  /**
   * Add multiple Things at once
   */
  async addThings(tdsOrUrls: (string | ThingDescription)[]): Promise<TranslatedThing[]> {
    const results: TranslatedThing[] = [];
    
    for (const tdOrUrl of tdsOrUrls) {
      const translated = await this.addThing(tdOrUrl);
      results.push(translated);
    }

    return results;
  }

  /**
   * Get all registered things
   */
  getThings(): TranslatedThing[] {
    return Array.from(this.translatedThings.values());
  }

  /**
   * Get a specific thing by ID
   */
  getThing(thingId: string): TranslatedThing | undefined {
    return this.translatedThings.get(thingId);
  }

  /**
   * Manually push an event (useful for testing or custom event sources)
   */
  async pushEvent(thingId: string, eventName: string, data: unknown): Promise<void> {
    await this.mcpServer.handleWotEvent(thingId, eventName, data);
  }

  /**
   * Get the underlying WoT client (for advanced usage)
   */
  getWotClient(): WotClient {
    return this.client;
  }

  /**
   * Get the underlying MCP server (for advanced usage)
   */
  getMcpServer(): McpServer {
    return this.mcpServer;
  }
}
