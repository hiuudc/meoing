declare module "lodash-es" {
  export function debounce<T extends (...args: never[]) => unknown>(
    callback: T,
    wait?: number,
    options?: { maxWait?: number },
  ): T & {
    cancel(): void;
    flush(): ReturnType<T> | undefined;
  };
}
