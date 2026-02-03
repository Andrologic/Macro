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
  description?: string;
  capabilities?: string[];
}

export const mockProviders: AIProviderOption[] = [
  { id: 'openai', name: 'OpenAI', status: 'online' },
  { id: 'openrouter', name: 'OpenRouter', status: 'online' },
  { id: 'zai', name: 'z.ai', status: 'online' },
  { id: 'anthropic', name: 'Anthropic', status: 'online' },
  { id: 'local', name: 'Local', status: 'degraded' },
];

export const mockModels: AIModelOption[] = [
  { id: 'gpt-4o', name: 'GPT-4o', providerId: 'openai', description: 'Fast, multimodal, excellent for code', capabilities: ['Code Generation', 'Multimodal', 'Fast Response'] },
  { id: 'gpt-4.1', name: 'GPT-4.1', providerId: 'openai', description: 'Most capable model with superior reasoning', capabilities: ['Complex Reasoning', 'Code Review', 'Architecture Design'] },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', providerId: 'openrouter', description: 'OpenRouter routed model (fast + cheap)', capabilities: ['Fast Response', 'Cost Efficient'] },
  { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', providerId: 'openrouter', description: 'OpenRouter routed Claude Sonnet', capabilities: ['Long Context', 'Code Analysis'] },
  { id: 'glm-4.5', name: 'GLM-4.5', providerId: 'zai', description: 'z.ai flagship model', capabilities: ['Reasoning', 'Code Generation'] },
  { id: 'glm-4', name: 'GLM-4', providerId: 'zai', description: 'z.ai balanced model', capabilities: ['General Chat', 'Text Analysis'] },
  { id: 'claude-3.7', name: 'Claude 3.7', providerId: 'anthropic', description: 'High accuracy with excellent context understanding', capabilities: ['Long Context', 'Code Analysis', 'Documentation'] },
  { id: 'claude-3.5', name: 'Claude 3.5', providerId: 'anthropic', description: 'Balanced performance with good reasoning', capabilities: ['Code Generation', 'Text Analysis', 'Problem Solving'] },
  { id: 'llama3-70b', name: 'Llama 3 70B', providerId: 'local', description: 'Local open-source model for privacy', capabilities: ['Local Processing', 'Privacy', 'No API Costs'] },
];
