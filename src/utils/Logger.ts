/**
 * Logger
 * 
 * Simple logging utility with log levels and formatting.
 */

export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
    NONE = 4
}

export class Logger {
    private static instance: Logger;
    private level: LogLevel = LogLevel.INFO;
    private prefix: string = '[wot-mcp]';

    private constructor() {}

    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    public setLevel(level: LogLevel): void {
        this.level = level;
    }

    public setPrefix(prefix: string): void {
        this.prefix = prefix;
    }

    private formatMessage(level: string, message: string, ...args: any[]): string {
        const timestamp = new Date().toISOString();
        const formattedArgs = args.map(arg => {
            if (arg instanceof Error) {
                return arg.stack || arg.message;
            }
            return typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg;
        }).join(' ');
        return `${timestamp} ${this.prefix} ${level}: ${message} ${formattedArgs}`;
    }

    public debug(message: string, ...args: any[]): void {
        if (this.level <= LogLevel.DEBUG) {
            console.error(this.formatMessage('DEBUG', message, ...args));
        }
    }

    public info(message: string, ...args: any[]): void {
        if (this.level <= LogLevel.INFO) {
            console.error(this.formatMessage('INFO', message, ...args));
        }
    }

    public warn(message: string, ...args: any[]): void {
        if (this.level <= LogLevel.WARN) {
            console.error(this.formatMessage('WARN', message, ...args));
        }
    }

    public error(message: string, ...args: any[]): void {
        if (this.level <= LogLevel.ERROR) {
            console.error(this.formatMessage('ERROR', message, ...args));
        }
    }
}

export const logger = Logger.getInstance();
