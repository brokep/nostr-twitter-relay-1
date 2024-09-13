require('dotenv').config();
console.log('TWITTER_API_KEY:', process.env.TWITTER_API_KEY ? 'Set' : 'Not set');
console.log('TWITTER_API_SECRET:', process.env.TWITTER_API_SECRET ? 'Set' : 'Not set');
const WebSocket = require('ws');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { TwitterApi } = require('twitter-api-v2');
const { getEventHash, getPublicKey, signEvent } = require('nostr-tools');

const app = express();
app.use(bodyParser.json());
app.use(cors());

const db = new sqlite3.Database('./nostr.db');

// Create events table if it doesn't exist
db.run(`CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  pubkey TEXT,
  created_at INTEGER,
  kind INTEGER,
  tags TEXT,
  content TEXT,
  sig TEXT
)`);

const wss = new WebSocket.Server({ noServer: true });

const clients = new Set();

// Nostr setup
const privateKey = process.env.NOSTR_PRIVATE_KEY;
const publicKey = getPublicKey(privateKey);

// Twitter client setup
const twitterClient = new TwitterApi({
  appKey: process.env.TWITTER_API_KEY,
  appSecret: process.env.TWITTER_API_SECRET,
});

wss.on('connection', (ws) => {
  clients.add(ws);

  ws.on('message', (message) => {
    try {
      const [type, ...data] = JSON.parse(message);

      if (type === 'EVENT') {
        const event = data[0];
        if (event && event.id && event.pubkey && event.created_at && event.kind && event.content && event.sig) {
          db.run(`INSERT OR IGNORE INTO events (id, pubkey, created_at, kind, tags, content, sig) 
                  VALUES (?, ?, ?, ?, ?, ?, ?)`, 
                  [event.id, event.pubkey, event.created_at, event.kind, JSON.stringify(event.tags), event.content, event.sig]);

          broadcastEvent(event);
        }
      } else if (type === 'REQ') {
        // Handle subscription requests (implement as needed)
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
  });
});

function broadcastEvent(event) {
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(['EVENT', event]));
    }
  }
}

async function postToNostr(content) {
  const event = {
    kind: 1,
    pubkey: publicKey,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: content
  };

  event.id = getEventHash(event);
  event.sig = signEvent(event, privateKey);

  db.run(`INSERT OR IGNORE INTO events (id, pubkey, created_at, kind, tags, content, sig) 
          VALUES (?, ?, ?, ?, ?, ?, ?)`, 
          [event.id, event.pubkey, event.created_at, event.kind, JSON.stringify(event.tags), event.content, event.sig]);

  broadcastEvent(event);
}

async function startTwitterMirroring() {
    const username = process.env.TWITTER_USERNAME;
    
    console.log(`Attempting to mirror tweets from @${username}`);
  
    try {
      console.log("Authenticating with Twitter...");
      const appOnlyClient = await twitterClient.appLogin();
      console.log("Authentication successful");
  
      let newestId = null;
  
      async function fetchAndProcessTweets() {
        try {
          console.log(`Fetching tweets for @${username}`);
          const query = `from:${username} -is:retweet -is:reply`;
          const tweets = await appOnlyClient.v2.search(query, {
            'tweet.fields': 'created_at',
            max_results: 10,
            since_id: newestId
          });
  
          console.log(`Fetched ${tweets.data.length} new tweets`);
  
          for (const tweet of tweets.data) {
            console.log(`Processing tweet: ${tweet.text}`);
            await postToNostr(tweet.text);
          }
  
          if (tweets.data.length > 0) {
            newestId = tweets.meta.newest_id;
          }
        } catch (error) {
          console.error('Error fetching tweets:', error);
          if (error.data) {
            console.error('Error details:', JSON.stringify(error.data, null, 2));
          }
        }
  
        console.log("Scheduling next fetch in 60 seconds");
        setTimeout(fetchAndProcessTweets, 60000); // Corrected function name
      }
  
      fetchAndProcessTweets();
  
    } catch (error) {
      console.error('Error in startTwitterMirroring:', error);
      if (error.data) {
        console.error('Error details:', JSON.stringify(error.data, null, 2));
      }
    }
  }

const server = app.listen(3000, () => {
  console.log('Nostr relay is running on port 3000');
  startTwitterMirroring();
});

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});
