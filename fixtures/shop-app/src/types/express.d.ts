declare module 'express' {
  export interface Request {
    params: Record<string, string>;
    query: Record<string, string | undefined>;
    body: unknown;
    headers: Record<string, string | string[] | undefined>;
    method: string;
    path: string;
    url: string;
  }

  export interface Response {
    status(code: number): this;
    json(body: unknown): this;
    send(body: string | Buffer): this;
    sendFile(path: string): void;
  }

  export interface NextFunction {
    (err?: Error): void;
  }

  export type RequestHandler = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

  export interface Router {
    get(path: string, ...handlers: RequestHandler[]): this;
    post(path: string, ...handlers: RequestHandler[]): this;
    put(path: string, ...handlers: RequestHandler[]): this;
    delete(path: string, ...handlers: RequestHandler[]): this;
    use(path: string, ...handlers: RequestHandler[]): this;
    use(...handlers: RequestHandler[]): this;
    use(router: Router): this;
    use(path: string, router: Router): this;
  }

  export function Router(): Router;
  export function json(): RequestHandler;
  export function urlencoded(options?: { extended?: boolean }): RequestHandler;
  export function static(root: string, options?: object): RequestHandler;

  export interface Application {
    use(handler: RequestHandler): this;
    use(path: string, handler: RequestHandler): this;
    use(router: Router): this;
    use(path: string, router: Router): this;
    get(path: string, ...handlers: RequestHandler[]): this;
    post(path: string, ...handlers: RequestHandler[]): this;
    listen(port: number | string, callback?: () => void): import('node:http').Server;
  }

  export interface Express extends Application {
    Router: typeof Router;
    json: typeof json;
    urlencoded: typeof urlencoded;
    static: typeof static;
    (): Application;
  }

  export const express: Express;
  export default express;
}