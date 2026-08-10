UPDATE provider_configs AS provider
SET
    is_enabled = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE provider.id IN (
    'chatgpt',
    'copilot',
    'openai',
    'zai',
    'anthropic',
    'openrouter',
    'minimax',
    'opencode-go',
    'ollama',
    'lmstudio'
)
  AND provider.is_enabled <> 0
  AND provider.has_stored_api_key = 0
  AND COALESCE(TRIM(provider.api_key), '') = ''
  AND COALESCE(provider.auth_status, '') NOT IN (
      'authenticated',
      'refreshing',
      'expired',
      'connected'
  )
  AND NOT EXISTS (
      SELECT 1
      FROM ai_models AS model
      WHERE model.provider_id = provider.id
  );
