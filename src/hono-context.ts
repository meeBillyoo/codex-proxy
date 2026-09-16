
declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
    authRole?: "master";
  }
}

export {};
