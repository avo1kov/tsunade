declare module 'pg' {
  export class Pool {
    constructor(config?: { connectionString?: string });
    query(sql: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number }>;
    end(): Promise<void>;
  }
}
