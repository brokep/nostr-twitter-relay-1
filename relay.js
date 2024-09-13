// Load environment variables
require('dotenv').config();
console.log('TWITTER_API_KEY:', process.env.TWITTER_API_KEY ? 'Set' : 'Not set');
console.log('TWITTER_API_SECRET:', process.env.TWITTER_API_SECRET ? 'Set' : 'Not set');

// Import required libraries
const WebSocket = require('ws');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { TwitterApi } = require('twitter-api-v2');
const { getEventHash, getPublicKey, signEvent } = require('nostr-tools');

// Set up Express server
const app = express();
app.use(bodyParser.json());
app.use(cors());

// Set up SQLite database
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

// Set up WebSocket server
const wss = new WebSocket.Server({ noServer: true });

// Store connected clients
const clients = new Set();

// Nostr setup
const privateKey = process.env.NOSTR_PRIVATE_KEY;
const publicKey = getPublicKey(privateKey);

// Twitter client setup
const twitterClient = new TwitterApi({
  appKey: process.env.TWITTER_API_KEY,
  appSecret: process.env.TWITTER_API_SECRET,
});

// Handle WebSocket connections
wss.on('connection', (ws) => {
  clients.add(ws);

  // Handle incoming messages
  ws.on('message', (message) => {
    try {
      const [type, ...data] = JSON.parse(message);

      if (type === 'EVENT') {
        // Handle incoming Nostr events
        const event = data[0];
        if (event && event.id && event.pubkey && event.created_at && event.kind && event.content && event.sig) {
          // Store event in database
          db.run(`INSERT OR IGNORE INTO events (id, pubkey, created_at, kind, tags, content, sig) 
                  VALUES (?, ?, ?, ?, ?, ?, ?)`, 
                  [event.id, event.pubkey, event.created_at, event.kind, JSON.stringify(event.tags), event.content, event.sig]);

          // Broadcast event to all clients
          broadcastEvent(event);
        }
      } else if (type === 'REQ') {
        // Handle subscription requests (implement as needed)
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  // Remove client on disconnect
  ws.on('close', () => {
    clients.delete(ws);
  });
});

// Broadcast event to all connected clients
function broadcastEvent(event) {
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(['EVENT', event]));
    }
  }
}

// Post content to Nostr network
async function postToNostr(content) {
  // Create Nostr event
  const event = {
    kind: 1,
    pubkey: publicKey,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: content
  };

  // Sign event
  event.id = getEventHash(event);
  event.sig = signEvent(event, privateKey);

  // Store event in database
  db.run(`INSERT OR IGNORE INTO events (id, pubkey, created_at, kind, tags, content, sig) 
          VALUES (?, ?, ?, ?, ?, ?, ?)`, 
          [event.id, event.pubkey, event.created_at, event.kind, JSON.stringify(event.tags), event.content, event.sig]);

  // Broadcast event to all clients
  broadcastEvent(event);
}

// Start Twitter mirroring process
async function startTwitterMirroring() {
  const username = process.env.TWITTER_USERNAME;
  
  console.log(`Attempting to mirror tweets from @${username}`);

  try {
    // Authenticate with Twitter
    console.log("Authenticating with Twitter...");
    const appOnlyClient = await twitterClient.appLogin();
    console.log("Authentication successful");

    // Fetch user data
    console.log("Fetching user data...");
    const user = await appOnlyClient.v2.userByUsername(username);
    console.log(`User data fetched for @${username}, ID: ${user.data.id}`);

    let lastTweetId = null;

    // Function to fetch and process tweets
    async function fetchAndProcessTweets() {
      try {
        console.log(`Fetching tweets for user ID: ${user.data.id}`);
        // Fetch recent tweets
        const tweets = await appOnlyClient.v2.userTimeline(user.data.id, {
          exclude: ['retweets', 'replies'],
          max_results: 10,
          since_id: lastTweetId
        });

        console.log(`Fetched ${tweets.data.data ? tweets.data.data.length : 0} new tweets`);

        if (tweets.data.data && tweets.data.data.length > 0) {
          // Process each new tweet
          for (const tweet of tweets.data.data) {
            console.log(`Processing tweet: ${tweet.text}`);
            await postToNostr(tweet.text);
          }
          lastTweetId = tweets.data.meta.newest_id;
        }
      } catch (error) {
        console.error('Error fetching tweets:', error);
        if (error.data) {
          console.error('Error details:', JSON.stringify(error.data, null, 2));
        }
      }

      // Schedule next fetch
      console.log("Scheduling next fetch in 60 seconds");
      setTimeout(fetchAndProcessTweets, 60000); // Fetch every 60 seconds
    }

    // Start fetching tweets
    fetchAndProcessTweets();

  } catch (error) {
    console.error('Error in startTwitterMirroring:', error);
    if (error.data) {
      console.error('Error details:', JSON.stringify(error.data, null, 2));
    }
  }
}

// Start the server
const server = app.listen(3000, () => {
  console.log('Nostr relay is running on port 3000');
  startTwitterMirroring();
});

// Handle WebSocket upgrade
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});
