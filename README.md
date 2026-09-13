I'm building a missed-call/lead-recovery system for local service businesses using Make.com, Twilio, and Google Gemini API. I need you to create a small Node.js server with these exact specs, then give me the files to download:

What it does: When a customer calls a business and the call goes unanswered, Make.com detects it and tells this server to call the customer back. When they answer, Twilio connects them to a live AI voice conversation powered by Twilio's ConversationRelay feature, using Google Gemini as the "brain" answering their questions about the business.

Files needed:

server.js — an Express + WebSocket server with:
A /twiml POST endpoint that returns TwiML connecting the call to a ConversationRelay WebSocket
A /trigger-callback POST endpoint that Make.com calls with a phone number, which uses the Twilio Node SDK to place an outbound call
A WebSocket server at /relay that receives Twilio's setup, prompt, and interrupt message types, sends the caller's transcribed speech to Gemini's API (model: gemini-2.0-flash), and sends Gemini's reply back as a text message type for Twilio to speak aloud
Config via environment variables: GEMINI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER, PUBLIC_HOSTNAME, BUSINESS_NAME, BUSINESS_INFO
package.json — with dependencies: express, ws, twilio, node-fetch
.env.example — listing all the environment variables above with example values
README.md — plain-language, no-coding-required deployment instructions for a complete beginner, covering: signing up for Render.com, uploading via GitHub, setting environment variables, deploying, and connecting the /trigger-callback endpoint to a Make.com scenario
Please create all four files and make them downloadable, then walk me through deploying step by step, assuming I have zero coding experience
