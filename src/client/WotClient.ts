/**
 * WotClient
 * 
 * Connects to WoT Things using node-wot and provides
 * a simplified interface for the MCP bridge.
 */

import { Servient } from '@node-wot/core';
import * as HttpPkg from '@node-wot/binding-http';
import * as CoapPkg from '@node-wot/binding-coap';
import * as MqttPkg from '@node-wot/binding-mqtt';

const HttpClientFactory = HttpPkg.HttpClientFactory || (HttpPkg as any).default?.HttpClientFactory;
const HttpsClientFactory = HttpPkg.HttpsClientFactory || (HttpPkg as any).default?.HttpsClientFactory;
const CoapClientFactory = CoapPkg.CoapClientFactory || (CoapPkg as any).default?.CoapClientFactory;
const MqttClientFactory = MqttPkg.MqttClientFactory || (MqttPkg as any).default?.MqttClientFactory;

import { ConsumedThing, ThingDescription } from 'wot-typescript-definitions';
import { logger } from '../utils/Logger.js';

export interface WotClientConfig {
  // Enable HTTP binding
  http?: boolean;
  // Enable CoAP binding
  coap?: boolean;
  // Enable MQTT binding
  mqtt?: boolean;
  // Custom servient (if you want full control)
  servient?: Servient;
}

export interface ConsumedThingWrapper {
  thing: ConsumedThing;
  td: ThingDescription;
}

type EventCallback = (eventName: string, data: unknown) => void;

export class WotClient {
  private servient: Servient;
  private wotHelper!: typeof WoT;
  private consumedThings: Map<string, ConsumedThingWrapper> = new Map();
  private eventSubscriptions: Map<string, Map<string, Subscription>> = new Map();
  private initialized = false;

  constructor(config: WotClientConfig = {}) {
    if (config.servient) {
      this.servient = config.servient;
    } else {
      this.servient = new Servient();
      
      if (config.http) {
        const HttpFactoryCtor = (HttpClientFactory as any);
        let httpFactoryInstance: any;
        if (typeof HttpFactoryCtor === 'function') {
          httpFactoryInstance = new HttpFactoryCtor();
        } else if (HttpFactoryCtor && typeof HttpFactoryCtor.default === 'function') {
          httpFactoryInstance = new (HttpFactoryCtor.default)();
        } else if (HttpFactoryCtor && typeof HttpFactoryCtor.HttpClientFactory === 'function') {
          httpFactoryInstance = new (HttpFactoryCtor.HttpClientFactory)();
        } else {
          httpFactoryInstance = HttpFactoryCtor;
        }
        
        if (httpFactoryInstance) {
          this.servient.addClientFactory(httpFactoryInstance);
        }

        const HttpsFactoryCtor = (HttpsClientFactory as any);
        let httpsFactoryInstance: any;
        if (typeof HttpsFactoryCtor === 'function') {
          httpsFactoryInstance = new HttpsFactoryCtor();
        } else if (HttpsFactoryCtor && typeof HttpsFactoryCtor.default === 'function') {
          httpsFactoryInstance = new (HttpsFactoryCtor.default)();
        } else if (HttpsFactoryCtor && typeof HttpsFactoryCtor.HttpsClientFactory === 'function') {
          httpsFactoryInstance = new (HttpsFactoryCtor.HttpsClientFactory)();
        } else {
          httpsFactoryInstance = HttpsFactoryCtor;
        }
        if (httpsFactoryInstance) {
          this.servient.addClientFactory(httpsFactoryInstance);
        }
      }
      if (config.coap) {
        const CoapFactoryCtor = (CoapClientFactory as any);
        let coapFactoryInstance: any;
        if (typeof CoapFactoryCtor === 'function') {
          coapFactoryInstance = new CoapFactoryCtor();
        } else if (CoapFactoryCtor && typeof CoapFactoryCtor.default === 'function') {
          coapFactoryInstance = new (CoapFactoryCtor.default)();
        } else if (CoapFactoryCtor && typeof CoapFactoryCtor.CoapClientFactory === 'function') {
          coapFactoryInstance = new (CoapFactoryCtor.CoapClientFactory)();
        } else {
          coapFactoryInstance = CoapFactoryCtor;
        }
        if (coapFactoryInstance) {
          this.servient.addClientFactory(coapFactoryInstance);
        }
      }
      if (config.mqtt) {
        const MqttFactoryCtor = (MqttClientFactory as any);
        let mqttFactoryInstance: any;
        if (typeof MqttFactoryCtor === 'function') {
          mqttFactoryInstance = new MqttFactoryCtor();
        } else if (MqttFactoryCtor && typeof MqttFactoryCtor.default === 'function') {
          mqttFactoryInstance = new (MqttFactoryCtor.default)();
        } else if (MqttFactoryCtor && typeof MqttFactoryCtor.MqttClientFactory === 'function') {
          mqttFactoryInstance = new (MqttFactoryCtor.MqttClientFactory)();
        } else {
          mqttFactoryInstance = MqttFactoryCtor;
        }
        if (mqttFactoryInstance) {
          this.servient.addClientFactory(mqttFactoryInstance);
        }
      }
    }
  }

  /**
   * Initialize the WoT client
   */
  async start(): Promise<void> {
    if (this.initialized) return;
    this.wotHelper = await this.servient.start();
    this.initialized = true;
  }

  /**
   * Stop the client and clean up
   */
  async stop(): Promise<void> {
    // Unsubscribe from all events
    for (const [thingId, subs] of this.eventSubscriptions) {
      for (const [, sub] of subs) {
        await sub.stop();
      }
    }
    this.eventSubscriptions.clear();
    this.consumedThings.clear();
    
    await this.servient.shutdown();
    this.initialized = false;
  }

  /**
   * Consume a Thing from its TD URL or object
   */
  async consume(tdOrUrl: string | ThingDescription): Promise<ConsumedThingWrapper> {
    if (!this.initialized) {
      await this.start();
    }

    let td: ThingDescription;
    
    if (typeof tdOrUrl === 'string') {
      td = await this.wotHelper.requestThingDescription(tdOrUrl);
    } else {
      td = tdOrUrl;
    }

    const thing = await this.wotHelper.consume(td);
    const thingId = this.extractThingId(td);
    
    logger.debug(`Consumed thing: ${thingId}`);

    const wrapper: ConsumedThingWrapper = { thing, td };
    this.consumedThings.set(thingId, wrapper);
    
    return wrapper;
  }

  /**
   * Get a consumed thing by ID
   */
  getThing(thingId: string): ConsumedThingWrapper | undefined {
    return this.consumedThings.get(thingId);
  }

  /**
   * Get all consumed things
   */
  getAllThings(): Map<string, ConsumedThingWrapper> {
    return this.consumedThings;
  }

  /**
   * Read a property from a Thing
   */
  async readProperty(thingId: string, propertyName: string): Promise<unknown> {
    const wrapper = this.consumedThings.get(thingId);
    if (!wrapper) {
      throw new Error(`Thing not found: ${thingId}`);
    }

    try {
      const output = await wrapper.thing.readProperty(propertyName);
      const value = await output.value();
      logger.debug(`Read property ${thingId}.${propertyName}:`, value);
      return value;
    } catch (error: any) {
      logger.error(`Failed to read property ${thingId}.${propertyName}:`, error);
      throw new Error(`Failed to read property '${propertyName}' from '${thingId}': ${error.message || error}`);
    }
  }

  /**
   * Write a property to a Thing
   */
  async writeProperty(thingId: string, propertyName: string, value: unknown): Promise<void> {
    const wrapper = this.consumedThings.get(thingId);
    if (!wrapper) {
      throw new Error(`Thing not found: ${thingId}`);
    }

    try {
      logger.debug(`Writing property ${thingId}.${propertyName}:`, value);
      await wrapper.thing.writeProperty(propertyName, value as any);
    } catch (error: any) {
      logger.error(`Failed to write property ${thingId}.${propertyName}:`, error);
      throw new Error(`Failed to write property '${propertyName}' to '${thingId}': ${error.message || error}`);
    }
  }

  /**
   * Invoke an action on a Thing
   */
  async invokeAction(thingId: string, actionName: string, params?: unknown): Promise<unknown> {
    const wrapper = this.consumedThings.get(thingId);
    if (!wrapper) {
      throw new Error(`Thing not found: ${thingId}`);
    }

    try {
      logger.debug(`Invoking action ${thingId}.${actionName} with params:`, params);
      logger.debug(`Params type: ${typeof params}, JSON: ${JSON.stringify(params)}`);
      const output = await wrapper.thing.invokeAction(actionName, params as any);
      if (output) {
        const result = await output.value();
        logger.debug(`Action ${thingId}.${actionName} result:`, result);
        return result;
      }
      return undefined;
    } catch (error: any) {
      logger.error(`Failed to invoke action ${thingId}.${actionName}:`, error);
      throw new Error(`Failed to invoke action '${actionName}' on '${thingId}': ${error.message || error}`);
    }
  }

  /**
   * Subscribe to events from a Thing
   */
  async subscribeEvent(
    thingId: string,
    eventName: string,
    callback: EventCallback
  ): Promise<void> {
    const wrapper = this.consumedThings.get(thingId);
    if (!wrapper) {
      throw new Error(`Thing not found: ${thingId}`);
    }

    logger.debug(`Subscribing to event ${thingId}.${eventName}`);

    // Initialize subscription map for this thing
    if (!this.eventSubscriptions.has(thingId)) {
      this.eventSubscriptions.set(thingId, new Map());
    }

    const thingSubs = this.eventSubscriptions.get(thingId)!;
    
    // Unsubscribe if already subscribed
    if (thingSubs.has(eventName)) {
      await thingSubs.get(eventName)!.stop();
    }

    // Subscribe to the event
    const sub = await wrapper.thing.subscribeEvent(eventName, async (output) => {
      const data = await output.value();
      logger.debug(`Received event ${thingId}.${eventName}:`, data);
      callback(eventName, data);
    });

    thingSubs.set(eventName, sub);
  }

  /**
   * Unsubscribe from an event
   */
  async unsubscribeEvent(thingId: string, eventName: string): Promise<void> {
    const thingSubs = this.eventSubscriptions.get(thingId);
    if (!thingSubs) return;

    const sub = thingSubs.get(eventName);
    if (sub) {
      await sub.stop();
      thingSubs.delete(eventName);
    }
  }

  /**
   * Subscribe to all events from a Thing
   */
  async subscribeAllEvents(thingId: string, callback: EventCallback): Promise<void> {
    const wrapper = this.consumedThings.get(thingId);
    if (!wrapper) {
      throw new Error(`Thing not found: ${thingId}`);
    }

    const events = wrapper.td.events;
    if (!events) return;

    for (const eventName of Object.keys(events)) {
      await this.subscribeEvent(thingId, eventName, callback);
    }
  }


  /**
   * Extract thing ID from TD
   */
  private extractThingId(td: ThingDescription): string {
    if (td.id) {
      const parts = td.id.split(/[:/]/);
      return parts[parts.length - 1].toLowerCase().replace(/[^a-z0-9]+/g, '-');
    }
    return td.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  }
}

// Type for WoT subscription (node-wot doesn't export this cleanly)
interface Subscription {
  stop(): Promise<void>;
}
