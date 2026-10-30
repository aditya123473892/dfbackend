// Run from dfbackend after npm run build. Never prints credentials.
require('dotenv').config();
const { ConfigService } = require('@nestjs/config');
const { LlmClient } = require('../dist/src/god-chat/llm.client');

const client = new LlmClient(new ConfigService());
client.complete([{ role: 'user', content: 'Reply with exactly: OK' }])
  .then((reply) => console.log(`DeepSeek smoke test succeeded: ${reply}`))
  .catch((error) => {
    console.error(`DeepSeek smoke test failed: ${error.message}`);
    process.exitCode = 1;
  });
