// Minimal type stubs for packages that are in package.json but not yet
// installed locally. These are intentionally loose (any) so the compiler
// does not cascade errors from missing modules.
// Once `pnpm install` runs, real types from node_modules take precedence.

/* eslint-disable @typescript-eslint/no-explicit-any */

declare module "@slack/bolt" {
  export class App {
    constructor(opts: any);
    client: any;
    action(actionId: any, handler: (args: any) => Promise<void>): void;
    view(callbackId: any, handler: (args: any) => Promise<void>): void;
    event(eventName: any, handler: (args: any) => Promise<void>): void;
    error(handler: (err: any) => Promise<void>): void;
    start(): Promise<any>;
  }
  export type MessageEvent = any;
}

declare module "discord.js" {
  export const Events: any;
  export const GatewayIntentBits: any;
  export class Client {
    constructor(opts: any);
    on(event: any, listener: (...args: any[]) => any): this;
    once(event: any, listener: (...args: any[]) => any): this;
    channels: any;
    user: any;
    login(token: string): Promise<string>;
  }
  export class REST {
    constructor(opts: any);
    setToken(token: string): this;
    put(route: any, opts: any): Promise<any>;
  }
  export const Routes: any;
  export class SlashCommandBuilder {
    setName(name: string): this;
    setDescription(desc: string): this;
    addStringOption(fn: (o: any) => any): this;
    toJSON(): any;
  }
  export type Message = any;
  export type ChatInputCommandInteraction = any;
}
