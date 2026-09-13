// server.js
// Missed-call / lead-recovery voice AI server
// Express handles Twilio webhooks + Make.com trigger; a WebSocket server
// handles Twilio's ConversationRelay protocol and talks to Google Gemini.

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const twilio = require("twilio");
const fetch = require("node-fetch");

// ---------- Config (all from environment variables) ----------
const {
  GEMINI_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
  PUBLIC_HOSTNAME, // e.g. my-app.onrender.com (no protocol, no trailing slash)
  BUSINESS_NAME,
  BUSINESS_INFO,
  PORT = 3000,
} = process.env;

if (!GEMINI_API_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_NUMBER || !PUBLIC_HOSTNAME) {
  console.warn(
    "[WARN] One or more required environment variables are missing. " +
      "Check GEMINI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER, PUBLIC_HOSTNAME."
  );
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ---------- App / HTTP server ----------
const app = express();
app.use(express.urlencoded({ extended: false })); // Twilio posts form-encoded
app.use(express.json()); // Make.com posts JSON

const server = http.createServer(app);

// ---------- In-memory conversation history, keyed by Twilio callSid ----------
// NOTE: this resets if the server restarts. Fine for short phone calls.
const conversations = new Map();

function systemPrompt() {
  const name = BUSINESS_NAME || "our business";
  const info = BUSINESS_INFO || "No extra business info was provided.";
  return (
    `You are a friendly phone receptionist for "${name}". ` +
    `A customer just called and their call was missed, so you are calling them back. ` +
    `Speak naturally and conversationally, like a real person on the phone. ` +
    `Keep replies SHORT (1-3 sentences) since this is a live voice call. ` +
    `Use only the following business information to answer questions; if you ` +
    `don't know something, offer to have a team member follow up. ` +
    `Business info:\n${info}`
  );
}

// ---------- Route 1: TwiML endpoint ----------
// Twilio calls this (as the "url" of an outbound call, or an inbound call)
// to find out what to do. We tell it to connect to our ConversationRelay WS.
app.post("/twiml", (req, res) => {
  const wsUrl = `wss://${PUBLIC_HOSTNAME}/relay`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="${wsUrl}" welcomeGreeting="Hi, thanks for calling ${escapeXml(
    BUSINESS_NAME || "us"
  )} back! How can I help you today?" />
  </Connect>
</Response>`;

  res.type("text/xml");
  res.send(twiml);
});

function escapeXml(str) {
  return String(str).replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      case '"':
        return "&quot;";
    }
  });
}

// ---------- Route 2: trigger-callback endpoint (called by Make.com) ----------
// Expects JSON body: { "phoneNumber": "+15551234567" }
app.post("/trigger-callback", async (req, res) => {
  try {
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({ error: "Missing 'phoneNumber' in request body." });
    }

    const call = await twilioClient.calls.create({
      to: phoneNumber,
      from: TWILIO_NUMBER,
      url: `https://${PUBLIC_HOSTNAME}/twiml`,
    });

    console.log(`[trigger-callback] Placed call ${call.sid} to ${phoneNumber}`);
    res.json({ success: true, callSid: call.sid });
  } catch (err) {
    console.error("[trigger-callback] Error placing call:", err);
    res.status(500).json({ error: "Failed to place call.", details: err.message });
  }
});

// Simple health check, handy for confirming the server is alive
app.get("/", (req, res) => {
  res.send("Missed-call recovery server is running.");
});

// ---------- WebSocket server: Twilio ConversationRelay ----------
const wss = new WebSocketServer({ server, path: "/relay" });

wss.on("connection", (ws) => {
  console.log("[relay] New WebSocket connection from Twilio.");
  let callSid = null;

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      console.error("[relay] Failed to parse message:", raw.toString());
      return;
    }

    switch (msg.type) {
      case "setup": {
        // Sent once when the call connects. Contains callSid, from, to, etc.
        callSid = msg.callSid;
        conversations.set(callSid, []);
        console.log(`[relay] setup for call ${callSid} from ${msg.from} to ${msg.to}`);
        break;
      }

      case "prompt": {
        // Sent whenever Twilio has transcribed something the caller said.
        const userText = msg.voicePrompt || "";
        if (!userText) break;

        console.log(`[relay] (${callSid}) caller said: ${userText}`);

        const history = conversations.get(callSid) || [];
        history.push({ role: "user", parts: [{ text: userText }] });

        try {
          const replyText = await askGemini(history);
          history.push({ role: "model", parts: [{ text: replyText }] });
          conversations.set(callSid, history);

          ws.send(
            JSON.stringify({
              type: "text",
              token: replyText,
              last: true,
            })
          );
        } catch (err) {
          console.error("[relay] Gemini error:", err);
          ws.send(
            JSON.stringify({
              type: "text",
              token: "Sorry, I'm having trouble understanding right now. Could you repeat that?",
              last: true,
            })
          );
        }
        break;
      }

      case "interrupt": {
        // Caller started talking while the AI was speaking.
        console.log(`[relay] (${callSid}) caller interrupted the response.`);
        break;
      }

      default:
        console.log(`[relay] Unhandled message type: ${msg.type}`);
    }
  });

  ws.on("close", () => {
    console.log(`[relay] Connection closed for call ${callSid}`);
    if (callSid) conversations.delete(callSid);
  });

  ws.on("error", (err) => {
    console.error("[relay] WebSocket error:", err);
  });
});

// ---------- Gemini helper ----------
async function askGemini(history) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

  const body = {
    system_instruction: {
      parts: [{ text: systemPrompt() }],
    },
    contents: history,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const text =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join(" ") ||
    "Sorry, I don't have an answer for that right now.";

  return text.trim();
}

// ---------- Start server ----------
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`TwiML endpoint:      https://${PUBLIC_HOSTNAME}/twiml`);
  console.log(`Trigger endpoint:    https://${PUBLIC_HOSTNAME}/trigger-callback`);
  console.log(`ConversationRelay:   wss://${PUBLIC_HOSTNAME}/relay`);
});
