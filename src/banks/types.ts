export type BankOperationItem = {
  date: string;
  text: string;
  category: string;
  amount: number;
};

export interface BankCollectorContext {
  headless?: boolean;
}

export interface BankCollector {
  init(ctx?: BankCollectorContext): Promise<void>;
  loginAndPrepare(): Promise<void>;
  captureLoginQr(timeoutMs?: number): Promise<{ screenshotPath: string; x?: number; y?: number; width?: number; height?: number }>;
  collectOperations(maxPages?: number, onSnapshot?: (items: BankOperationItem[]) => Promise<void> | void): Promise<BankOperationItem[]>;
  shutdown(): Promise<void>;
}
