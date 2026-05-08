export interface KafkaPayload<T = unknown> {
  partionKey: string;
  data: T;
  headers?: Record<string, string>;
}

export interface KafkaModuleOptions {
  brokers: string[];
  groupId: string;
  clientId?: string;
  ssl?: boolean;
  sasl?: {
    mechanism: 'plain' | 'scram-sha-256' | 'scram-sha-512';
    username: string;
    password: string;
  };
  retry?: {
    retries: number;
    initialRetryTime: number;
  };
}
