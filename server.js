// Kingpin Solana Trading Bot - Production Server
// Deployed on Render.com with real Jupiter API access

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(helmet());
app.use(cors());
app.use(compression());
app.use(morgan('combined'));
app.use(express.json());

// State
const state = {
  wallet: {
    address: process.env.WALLET_ADDRESS || '3s4DjczzFbGwmD9UaLf4xKSCiFBk97noLdNcbUSxs5Uq',
    balance: 0.1,
    usdc: 0,
    total_value: 0,
    mode: 'LIVE'
  },
  stats: {
    total_trades: 0,
    successful_trades: 0,
    win_rate: 0,
    avg_execution_time: 0,
    mode: 'LIVE',
    bot_type: 'MOLDUK'
  },
  positions: [],
  speed_metrics: [],
  consumption: {
    api_calls: 0,
    compute_units: 0,
    gas_fees: 0,
    requests_per_min: 0,
    daily_calls: 0,
    last_reset: Date.now()
  },
  qwen: {
    connected: false,
    model: 'qwen-portal/coder-model',
    last_analysis: null,
    predictions: [],
    chat_enabled: true
  },
  token_usage: {
    input_tokens: 0,
    output_tokens: 0,
    api_calls: 0,
    total_tokens: 0,
    free_quota: 1000000,
    remaining_quota: 1000000
  },
  running: false,
  lastUpdate: Date.now()
};

// Jupiter API Client
class JupiterClient {
  constructor() {
    this.baseUrl = process.env.JUPITER_API || 'https://quote-api.jup.ag/v6';
    this.timeout = 10000;
  }

  async getQuote(inputMint, outputMint, amount) {
    return new Promise((resolve, reject) => {
      const url = `${this.baseUrl}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50&platformFeeBps=100`;
      
      const options = {
        hostname: 'quote-api.jup.ag',
        port: 443,
        path: `/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50`,
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'KingpinTrader/1.0'
        },
        timeout: this.timeout
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve({ success: true, data: json });
          } catch (e) {
            resolve({ success: false, error: 'Invalid JSON' });
          }
        });
      });

      req.on('error', (err) => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout'));
      });

      req.end();
    });
  }
}

const jupiter = new JupiterClient();

// Rate Limiter Class
class RateLimiter {
  constructor(maxRequests = 60, windowMs = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.requests = [];
    this.lastRequestTime = 0;
    this.minDelayMs = 2000; // Minimum 2 seconds between requests
  }

  async waitForSlot() {
    const now = Date.now();
    
    // Clean old requests outside window
    this.requests = this.requests.filter(time => now - time < this.windowMs);
    
    // Check if at rate limit
    if (this.requests.length >= this.maxRequests) {
      const oldestRequest = this.requests[0];
      const waitTime = this.windowMs - (now - oldestRequest);
      console.log(`â³ Rate limit reached. Waiting ${waitTime}ms...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return this.waitForSlot(); // Recursively check again
    }
    
    // Enforce minimum delay between requests
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.minDelayMs && this.lastRequestTime > 0) {
      const waitTime = this.minDelayMs - timeSinceLastRequest;
      console.log(`â³ Rate limiting: waiting ${waitTime}ms between requests...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    // Record this request
    this.requests.push(Date.now());
    this.lastRequestTime = Date.now();
  }

  getStats() {
    const now = Date.now();
    const recentRequests = this.requests.filter(time => now - time < this.windowMs);
    return {
      currentRequests: recentRequests.length,
      maxRequests: this.maxRequests,
      remaining: this.maxRequests - recentRequests.length,
      windowMs: this.windowMs
    };
  }
}

// Qwen AI Client
class QwenClient {
  constructor() {
    this.apiKey = process.env.QWEN_API_KEY || '';
    this.apiUrl = process.env.QWEN_API_URL || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation';
    this.model = process.env.QWEN_MODEL || 'qwen3.5-122b-a10b';
    this.enabled = !!this.apiKey;
    this.rateLimiter = new RateLimiter(60, 60000); // 60 requests per minute max
  }

  async waitForRateLimit() {
    await this.rateLimiter.waitForSlot();
  }

  getRateLimitStats() {
    return this.rateLimiter.getStats();
  }

  async analyzeTrade(position, marketData) {
    if (!this.enabled) return null;
    
    // Wait for rate limit slot
    await this.waitForRateLimit();

    const prompt = `Analyze this Solana trade position:
Token: ${position.token}
Entry: ${position.entry_price} SOL
Current PnL: ${position.pnl}%
Execution: ${position.execution_time}ms

Provide:
1. Hold/Sell recommendation
2. Risk assessment (Low/Medium/High)
3. Price target

Keep it brief (max 100 words).`;

    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.model,
          input: { messages: [{ role: 'user', content: prompt }] },
          parameters: { max_tokens: 150 }
        })
      });

      const data = await response.json();
      state.consumption.api_calls++;
      state.consumption.daily_calls++;
      
      // Track token usage
      if (data.usage) {
        state.token_usage.input_tokens += data.usage.input_tokens || 0;
        state.token_usage.output_tokens += data.usage.output_tokens || 0;
        state.token_usage.total_tokens = state.token_usage.input_tokens + state.token_usage.output_tokens;
        state.token_usage.remaining_quota = Math.max(state.token_usage.free_quota - state.token_usage.total_tokens, 0);
        state.token_usage.api_calls++;
      }
      
      return data.output?.text || null;
    } catch (err) {
      console.error('Qwen analysis error:', err.message);
      return null;
    }
  }

  async getMarketSentiment(tokens) {
    if (!this.enabled) return null;

    // Wait for rate limit slot
    await this.waitForRateLimit();

    const prompt = `Analyze market sentiment for these Solana tokens: ${tokens.join(', ')}.
Provide brief sentiment (Bullish/Bearish/Neutral) for each with 1-sentence reasoning.`;

    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.model,
          input: { messages: [{ role: 'user', content: prompt }] },
          parameters: { max_tokens: 200 }
        })
      });

      const data = await response.json();
      state.consumption.api_calls++;
      state.consumption.daily_calls++;
      
      // Track token usage
      if (data.usage) {
        state.token_usage.input_tokens += data.usage.input_tokens || 0;
        state.token_usage.output_tokens += data.usage.output_tokens || 0;
        state.token_usage.total_tokens = state.token_usage.input_tokens + state.token_usage.output_tokens;
        state.token_usage.remaining_quota = Math.max(state.token_usage.free_quota - state.token_usage.total_tokens, 0);
        state.token_usage.api_calls++;
      }
      
      return data.output?.text || null;
    } catch (err) {
      console.error('Qwen sentiment error:', err.message);
      return null;
    }
  }

  async chat(message, context = []) {
    if (!this.enabled) return { error: 'Qwen not configured' };

    // Wait for rate limit slot
    await this.waitForRateLimit();

    try {
      const messages = [...context, { role: 'user', content: message }];
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.model,
          input: { messages },
          parameters: { max_tokens: 500 }
        })
      });

      const data = await response.json();
      state.consumption.api_calls++;
      state.consumption.daily_calls++;
      
      // Track token usage
      if (data.usage) {
        state.token_usage.input_tokens += data.usage.input_tokens || 0;
        state.token_usage.output_tokens += data.usage.output_tokens || 0;
        state.token_usage.total_tokens = state.token_usage.input_tokens + state.token_usage.output_tokens;
        state.token_usage.remaining_quota = Math.max(state.token_usage.free_quota - state.token_usage.total_tokens, 0);
        state.token_usage.api_calls++;
      }
      
      return { 
        response: data.output?.text || 'No response',
        token_usage: data.usage || null
      };
    } catch (err) {
      return { error: err.message };
    }
  }
}

const qwen = new QwenClient();

// Trading Bot Logic
class TradingBot {
  constructor() {
    this.tokens = [
      { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', volatility: 0.15 },
      { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF', volatility: 0.25 },
      { mint: 'JUPyiwrYJFskUPiHa7hkeRUiStoGTJpcoMdaXykdt8V', symbol: 'JUP', volatility: 0.08 }
    ];
    this.minTradeSize = 0.01;
    this.feePercent = 1.0;
  }

  async scanAndTrade() {
    if (!state.running) return;

    console.log('ðŸ” Scanning for opportunities...');

    for (const token of this.tokens) {
      if (state.wallet.balance < this.minTradeSize + 0.005) {
        console.log('Insufficient balance');
        break;
      }

      try {
        const startTime = Date.now();
        
        // Get real Jupiter quote
        const result = await jupiter.getQuote(
          'So11111111111111111111111111111111111111112',
          token.mint,
          Math.floor(this.minTradeSize * 1e9)
        );

        if (result.success && result.data) {
          const executionTime = Date.now() - startTime;
          
          // Execute trade (simulated for now, would sign tx in production)
          console.log(`âœ… Trade opportunity: ${token.symbol}`);
          console.log(`   Execution time: ${executionTime}ms`);
          console.log(`   Expected output: ${result.data.outAmount / 1e9} tokens`);

          // Update state
          state.positions.push({
            token: token.symbol,
            amount: this.minTradeSize,
            status: 'OPEN',
            execution_time: executionTime,
            pnl: 0,
            entry_price: this.minTradeSize / (result.data.outAmount / 1e9),
            timestamp: Date.now()
          });

          state.wallet.balance -= this.minTradeSize;
          state.stats.total_trades++;
          state.stats.successful_trades++;
          
          // Update speed metrics
          state.speed_metrics.push({
            execution_time: executionTime,
            timestamp: Date.now()
          });

          // Keep only last 100
          if (state.speed_metrics.length > 100) {
            state.speed_metrics.shift();
          }

          // Calculate avg
          state.stats.avg_execution_time = Math.round(
            state.speed_metrics.reduce((a, b) => a + b.execution_time, 0) / state.speed_metrics.length
          );

          // Broadcast update
          broadcastState();
        }
      } catch (err) {
        console.error(`Error trading ${token.symbol}:`, err.message);
      }

      await this.sleep(2000);
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async start() {
    state.running = true;
    console.log('ðŸš€ Trading bot started');
    
    while (state.running) {
      await this.scanAndTrade();
      await this.sleep(10000); // Scan every 10 seconds
    }
  }

  stop() {
    state.running = false;
    console.log('ðŸ›‘ Trading bot stopped');
  }
}

const bot = new TradingBot();

// WebSocket broadcast
function broadcastState() {
  state.lastUpdate = Date.now();
  const message = JSON.stringify({
    type: 'state_update',
    data: state
  });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// API Routes
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Serve dashboard at root
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>MoldukBot Dashboard</title>
        <meta http-equiv="refresh" content="0;url=https://moldukbot.onrender.com/api/status">
        <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #0a0a0f; color: #fff; }
            h1 { color: #00ff88; }
            a { color: #00d2ff; text-decoration: none; }
            .links { margin-top: 30px; }
            .link-box { display: inline-block; margin: 10px; padding: 15px 30px; background: #1a1a2e; border: 1px solid #00d2ff; border-radius: 10px; }
        </style>
    </head>
    <body>
        <h1>ðŸŽ¯ MoldukBot Server</h1>
        <p>Status: <span style="color: #00ff88;">ONLINE</span></p>
        <div class="links">
            <div class="link-box"><a href="/api/status">ðŸ“Š API Status</a></div>
            <div class="link-box"><a href="/api/qwen/status">ðŸ§  Qwen AI</a></div>
            <div class="link-box"><a href="/health">âœ… Health Check</a></div>
        </div>
        <p style="margin-top: 30px; color: #888;">Use the local moldukbot.html for full dashboard</p>
    </body>
    </html>
  `);
});

app.get('/api/status', (req, res) => {
  res.json(state);
});

app.get('/api/wallet', (req, res) => {
  res.json(state.wallet);
});

app.get('/api/positions', (req, res) => {
  res.json(state.positions);
});

// Qwen AI Routes
app.get('/api/qwen/status', (req, res) => {
  res.json({
    connected: qwen.enabled,
    model: qwen.model,
    api_calls: state.consumption.api_calls,
    daily_calls: state.consumption.daily_calls,
    token_usage: state.token_usage,
    rate_limit: qwen.getRateLimitStats()
  });
});

app.get('/api/qwen/token-usage', (req, res) => {
  res.json({
    input_tokens: state.token_usage.input_tokens,
    output_tokens: state.token_usage.output_tokens,
    total_tokens: state.token_usage.total_tokens,
    api_calls: state.token_usage.api_calls,
    free_quota: state.token_usage.free_quota,
    remaining_quota: state.token_usage.remaining_quota,
    usage_percent: ((state.token_usage.total_tokens / state.token_usage.free_quota) * 100).toFixed(2)
  });
});

app.post('/api/qwen/analyze', async (req, res) => {
  const { position } = req.body;
  const analysis = await qwen.analyzeTrade(position, {});
  res.json({ analysis });
});

app.post('/api/qwen/sentiment', async (req, res) => {
  const { tokens } = req.body;
  const sentiment = await qwen.getMarketSentiment(tokens);
  res.json({ sentiment });
});

app.post('/api/qwen/chat', async (req, res) => {
  const { message, context } = req.body;
  const result = await qwen.chat(message, context);
  res.json(result);
});

app.post('/api/start', (req, res) => {
  if (!state.running) {
    bot.start();
    res.json({ success: true, message: 'Bot started' });
  } else {
    res.json({ success: false, message: 'Bot already running' });
  }
});

app.post('/api/stop', (req, res) => {
  bot.stop();
  res.json({ success: true, message: 'Bot stopped' });
});

// Serve dashboard
app.use(express.static('public'));

// WebSocket handling
wss.on('connection', (ws) => {
  console.log('Client connected');
  ws.send(JSON.stringify({ type: 'state_update', data: state }));
});

// Start server
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log('ðŸš€ MOLDUK TRADER - PRODUCTION');
  console.log(`   Server running on port ${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}`);
  console.log('-'.repeat(60));
  console.log('ðŸ¤– Qwen AI Integration:');
  console.log(`   Status: ${qwen.enabled ? 'âœ… CONNECTED' : 'âŒ NOT CONFIGURED'}`);
  console.log(`   Model: ${qwen.model}`);
  console.log(`   API URL: ${qwen.apiUrl}`);
  console.log('-'.repeat(60));
  console.log('ðŸ’° Wallet:', state.wallet.address.substring(0, 20) + '...');
  console.log('âš¡ Mode:', state.stats.mode);
  console.log('='.repeat(60));
  
  // Auto-start bot
  bot.start();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  bot.stop();
  server.close(() => {
    process.exit(0);
  });
});
