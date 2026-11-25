/* 内联的 @edgeone/pages-blob 的最小类型声明（够用即可） */
export declare function getStore(
  name: string | { name: string; projectId?: string; token?: string; consistency?: "eventual" | "strong" },
): any;
export declare function listStores(options?: Record<string, unknown>): Promise<any>;
export declare const Store: any;
declare const _default: any;
export default _default;
