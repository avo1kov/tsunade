export type BankOperationItem = {
  date: string;
  text: string;
  category: string;
  amount: number;
  message?: string;
  opTime?: string;
  opDateTimeText?: string;
  opId?: string;
  accountName?: string;
  accountMask?: string;
  counterparty?: string;
  counterpartyPhone?: string;
  counterpartyBank?: string;
  feeAmount?: number;
  totalAmount?: number;
  channel?: string;
};

export interface BankCollectorContext {
  headless?: boolean;
}

export interface BankCollector {
  init(ctx?: BankCollectorContext): Promise<void>;
  loginAndPrepare(): Promise<void>;
  collectOperations(maxPages?: number, onSnapshot?: (items: BankOperationItem[]) => Promise<void> | void): Promise<BankOperationItem[]>;
  shutdown(): Promise<void>;
}
