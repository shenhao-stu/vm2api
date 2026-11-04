-- Explicit GPT gateway binding; the existing slot scope remains the Claude scope.
ALTER TABLE api_keys ADD COLUMN openai_endpoint_id TEXT;
