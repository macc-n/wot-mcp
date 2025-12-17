#!/usr/bin/env node
import { WotMcpBridge } from './bridge/WotMcpBridge.js';
import { TransportMode, ToolStrategy } from './server/McpServer.js';
import { logger, LogLevel } from './utils/Logger.js';
import fs from 'fs';
import path from 'path';
import { ThingDescription } from 'wot-typescript-definitions';

interface ConfigThing {
    protocol: string;
    url: string;
    td?: string;
}

interface Config {
    things: ConfigThing[];
}

/**
 * Main entrypoint for the WoT-MCP Bridge Application
 */
async function main() {
    const args = process.argv.slice(2);
    
    if (args.includes('--help') || args.includes('-h')) {
        console.log(`
Usage: wot-mcp --config <file> [options]

Options:
  --config <file>   Load configuration from a JSON file (mandatory)
  --mode <mode>     Transport mode: 'stdio' (default) or 'streamable-http'
  --port <port>     Port for streamable-http mode (default: 3000)
  --tool-strategy <strategy>  Tool generation strategy: 'explicit' (default) or 'generic'
  --debug           Enable debug logging
  --help, -h        Show this help message

Examples:
  wot-mcp --config ./my-things.json
  wot-mcp --config ./my-things.json --mode streamable-http --port 3001
`);
        process.exit(0);
    }

    if (args.includes('--debug')) {
        logger.setLevel(LogLevel.DEBUG);
    }

    // Parse tool strategy
    const strategyIndex = args.indexOf('--tool-strategy');
    let toolStrategy: ToolStrategy = 'explicit';
    if (strategyIndex !== -1 && args[strategyIndex + 1]) {
        const strategyArg = args[strategyIndex + 1];
        if (strategyArg === 'explicit' || strategyArg === 'generic') {
            toolStrategy = strategyArg;
        } else {
            logger.error(`Error: Unknown tool strategy '${strategyArg}'. Supported strategies are 'explicit' and 'generic'.`);
            process.exit(1);
        }
    }

    // Handle Config File
    const configIndex = args.indexOf('--config');
    if (configIndex === -1 || !args[configIndex + 1]) {
        logger.error('Error: --config argument is mandatory.');
        process.exit(1);
    }

    const configPath = args[configIndex + 1];
    let config: Config;
    try {
        logger.info(`Loading config from ${configPath}...`);
        const configContent = fs.readFileSync(configPath, 'utf-8');
        config = JSON.parse(configContent);
    } catch (err) {
        logger.error(`Failed to load config file: ${err}`);
        process.exit(1);
    }

    if (!config.things || !Array.isArray(config.things)) {
        logger.error('Error: Config file must contain a "things" array.');
        process.exit(1);
    }

    // Determine protocols to enable
    const enableHttp = config.things.some(t => t.protocol === 'http' || t.protocol === 'https');
    const enableMqtt = config.things.some(t => t.protocol === 'mqtt');
    const enableCoap = config.things.some(t => t.protocol === 'coap');

    logger.info('Starting WoT-MCP...');

    const bridge = new WotMcpBridge({
        name: 'wot-mcp',
        version: '1.0.0',
        toolStrategy: toolStrategy,
        wot: {
            http: enableHttp,
            mqtt: enableMqtt,
            coap: enableCoap
        }
    });

    // Handle shutdown signals
    const cleanup = async () => {
        logger.info('Shutting down...');
        try {
            await bridge.stop();
            logger.info('Server stopped.');
            process.exit(0);
        } catch (error) {
            logger.error('Error during shutdown:', error);
            process.exit(1);
        }
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    try {
        // Start WoT Client first to allow fetching TDs
        await bridge.startClient();
        logger.info('WoT Client started.');

        // Add things from config
        for (const thingConfig of config.things) {
            if (thingConfig.protocol === 'mqtt') {
                if (!thingConfig.td) {
                    logger.error(`Error: MQTT thing ${thingConfig.url} missing 'td' field.`);
                    continue;
                }
                try {
                    let tdPath = thingConfig.td;
                    if (!path.isAbsolute(tdPath)) {
                        tdPath = path.resolve(path.dirname(configPath), tdPath);
                    }
                    const tdContent = fs.readFileSync(tdPath, 'utf-8');
                    const td = JSON.parse(tdContent) as ThingDescription;
                    await addThingSafe(bridge, td, thingConfig.url);
                } catch (err) {
                    logger.error(`Failed to load TD for MQTT thing ${thingConfig.url}: ${err}`);
                }
            } else {
                await addThingSafe(bridge, thingConfig.url);
            }
        }

        // Parse transport mode
        const modeIndex = args.indexOf('--mode');
        let transportMode: TransportMode = 'stdio';
        if (modeIndex !== -1 && args[modeIndex + 1]) {
            const modeArg = args[modeIndex + 1];
            if (modeArg === 'stdio' || modeArg === 'streamable-http') {
                transportMode = modeArg;
            } else {
                logger.error(`Error: Unknown transport mode '${modeArg}'. Supported modes are 'stdio' and 'streamable-http'.`);
                process.exit(1);
            }
        }

        // Parse port for streamable-http mode
        const portIndex = args.indexOf('--port');
        let port = 3000;
        if (portIndex !== -1 && args[portIndex + 1]) {
            const portArg = parseInt(args[portIndex + 1], 10);
            if (isNaN(portArg) || portArg < 1 || portArg > 65535) {
                logger.error(`Error: Invalid port '${args[portIndex + 1]}'. Must be a number between 1 and 65535.`);
                process.exit(1);
            }
            port = portArg;
        }

        // Start MCP Server after registering all things
        await bridge.startServer(transportMode, port);
        logger.info(`MCP Server started (${transportMode} transport).`);
        logger.info('Waiting for MCP connections...');

    } catch (error) {
        logger.error('Fatal error:', error);
        process.exit(1);
    }
}

async function addThingSafe(bridge: WotMcpBridge, tdOrUrl: string | ThingDescription, label?: string) {
    try {
        const display = typeof tdOrUrl === 'string' ? tdOrUrl : (label || 'TD Object');
        logger.info(`Adding thing from ${display}...`);
        const translated = await bridge.addThing(tdOrUrl);
        logger.info(`Added thing: ${translated.title || translated.id}`);
    } catch (err) {
        logger.error('Failed to add thing:', err);
    }
}

main();
