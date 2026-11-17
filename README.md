# Journey Relay

Split-view browser that relays a conversation between two AI chat sites, word for word, with a Claude moderator on the side.

## Setup (once)
1. Install **Node.js LTS** from https://nodejs.org
2. Double-click **start-mac.command** (Mac) or **start-windows.bat** (Windows).
   - Mac, first time: right-click > Open, then Open again (macOS blocks downloaded scripts once).
   - First run installs for 1-2 minutes, then the app opens.
3. Click the gear (⚙) and paste your **Anthropic API key** (console.anthropic.com > API Keys). This powers the moderator and the summary.
4. Log in to each site inside its pane. If "Sign in with Google" is blocked, use email login instead.

## Running a session
1. Type the **Task** and click **Start**. The relay rules are added automatically.
2. Watch the first hop or two and click **Pass** to send each one.
3. Once both AIs are following the format, click **Automate**.
4. Questions from the AIs show up in the moderator chat. Answer whenever you like, loosely ("budget's 40k, and yes to the oak"). The moderator attaches your answer to the next message going to both sides.
5. The session ends when both sides write SESSION COMPLETE, or at max turns.

## Notes
- **Presets:** ChatGPT, Claude, Gemini and Grok. For any other site, click **Teach** and click its input box, the AI's reply, then its send button.
- If a site redesigns and the relay stops working, click **Teach** again (10 seconds).
- **Test** checks that the app can find the input box and the latest reply.
- **AI name** (box next to the address) is the name used in the markers, e.g. CLAUDE. It's auto-filled for presets.
- The relay rules can be edited in ⚙ Settings.
- **Export** saves the full transcript as a Markdown file.
