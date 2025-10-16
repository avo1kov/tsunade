declare module 'playwright' {
  export interface BrowserContext {
    pages(): Page[];
    newPage(): Promise<Page>;
    close(): Promise<void>;
  }
  export interface ElementHandle {
    boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
    scrollIntoViewIfNeeded(): Promise<void>;
    click(options?: any): Promise<void>;
    type(text: string, options?: any): Promise<void>;
    fill(value: string, options?: any): Promise<void>;
  }
  export interface Page {
    goto(url: string, options?: any): Promise<any>;
    waitForLoadState(state?: 'load' | 'domcontentloaded' | 'networkidle', options?: any): Promise<void>;
    waitForSelector(selector: string, options?: any): Promise<ElementHandle | null>;
    setViewportSize(params: { width: number; height: number }): Promise<void>;
    screenshot(options?: any): Promise<Buffer>;
    $$(selector: string): Promise<ElementHandle[]>;
    evaluate<R>(pageFunction: string | ((...args: any[]) => R | Promise<R>), arg?: any): Promise<R>;
    waitForTimeout(timeout: number): Promise<void>;
  }
  export const chromium: {
    launchPersistentContext(userDataDir: string, options?: any): Promise<BrowserContext>;
  };
}


