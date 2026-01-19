export type ProviderStatus = 'online' | 'offline' | 'degraded';

export interface AIProviderOption {
  id: string;
  name: string;
  status: ProviderStatus;
}

export interface AIModelOption {
  id: string;
  name: string;
  providerId: string;
}

export const mockProviders: AIProviderOption[] = [
  { id: 'openai', name: 'OpenAI', status: 'online' },
  { id: 'anthropic', name: 'Anthropic', status: 'online' },
  { id: 'local', name: 'Local', status: 'degraded' },
];

export const mockModels: AIModelOption[] = [
  { id: 'gpt-4o', name: 'GPT-4o', providerId: 'openai' },
  { id: 'gpt-4.1', name: 'GPT-4.1', providerId: 'openai' },
  { id: 'claude-3.7', name: 'Claude 3.7', providerId: 'anthropic' },
  { id: 'claude-3.5', name: 'Claude 3.5', providerId: 'anthropic' },
  { id: 'llama3-70b', name: 'Llama 3 70B', providerId: 'local' },
];
